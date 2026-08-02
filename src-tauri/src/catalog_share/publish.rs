//! Publishing a catalogue: commit, push, and optionally a pull request.
//!
//! Orchestration only — the git transport lives in `git.rs`, the calls for things git
//! has no concept of (forking, pull requests) in `github.rs`, the credential
//! resolution in `auth.rs`, and the pre-publish secret scan in `secrets.rs`.
//!
//! ## Branches and pull requests are optional
//!
//! The default is to commit straight to the branch the catalogue was pulled from. Most
//! publishing is a decoder going back to a repository the user owns, where a branch
//! and a pull request are ceremony around a one-file change. Naming a branch creates
//! one; ticking "open a pull request" opens one. Neither is forced — not even when a
//! fork is involved, since pushing to your own fork and stopping is a legitimate way
//! to park work.
//!
//! Every step is idempotent by construction — an existing fork is reused, pushing an
//! existing branch adds a commit to it, an existing PR is reported rather than
//! duplicated — so recovery from a mid-flight failure is simply pressing Publish
//! again. There is deliberately **no rollback**: deleting a branch or fork on failure
//! risks destroying someone's work.

use std::path::PathBuf;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

use super::error::{ShareError, ShareErrorKind};
use super::github::{self, GitHubClient, NewRepo, RepoInfo};
use crate::catalog::DiffKind;
use super::registry::{CatalogEntry, CatalogSourceRegistry, ForkRef, PublishState};
use super::secrets::{self, SecretFinding};
use super::{auth, git, url::CatalogSource};

/// Tauri event carrying step-by-step progress. Window-scoped modal UI, so a Tauri
/// event rather than a WebSocket push (which also has a 10s timeout a fork poll
/// would blow through).
const PROGRESS_EVENT: &str = "catalog-publish-progress";

/// Backoff between fork-existence polls. Forking is asynchronous and eventually
/// consistent, so the first poll happens immediately and these are the gaps after it.
const FORK_POLL_BACKOFF: &[u64] = &[500, 1000, 2000, 4000, 8000, 8000, 8000, 8000, 8000];

// ── Request / result ─────────────────────────────────────────────────────────

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishRequest {
    /// Local catalogue filename within the decoder directory.
    pub filename: String,
    /// Target repository URL, re-parsed here rather than trusted as an identity.
    pub repo_url: String,
    /// Defaults to the provenance path, else `catalogs/{filename}`.
    #[serde(default)]
    pub target_path: Option<String>,
    /// Branch to commit to. `None` — the default — pushes straight to the base branch,
    /// which is the ref this catalogue was pulled from. Naming one creates it off the
    /// base instead.
    #[serde(default)]
    pub branch: Option<String>,
    pub commit_message: String,
    #[serde(default)]
    pub pr_title: String,
    #[serde(default)]
    pub pr_body: String,
    #[serde(default)]
    pub draft: bool,
    /// Open a pull request after pushing. Off by default: the common case is pushing a
    /// decoder to a repository you own, where a branch and a PR are ceremony around a
    /// one-file change. Deliberately **not** forced when a fork is involved either —
    /// pushing to your own fork without opening a PR is a legitimate way to park work.
    #[serde(default)]
    pub open_pr: bool,
    /// Increment `[meta].version` in the committed bytes, and write the bumped file
    /// back locally once the push has succeeded.
    ///
    /// **Off by the serde default while the dialog's checkbox is on**, and that
    /// asymmetry is the point: this is the one request field that rewrites a file in
    /// the user's decoder directory, so a caller that predates it — or any caller that
    /// is not the push dialog — must not do so by omission.
    #[serde(default)]
    pub bump_version: bool,
    /// Acknowledged secret-scan findings, so the confirm step can be explicit.
    #[serde(default)]
    pub accept_secret_findings: bool,
    /// Correlates progress events with the dialog that asked.
    #[serde(default)]
    pub request_id: String,
}

/// What publishing would do, computed without any writes.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishPlan {
    pub upstream: String,
    pub target_path: String,
    /// The branch that will actually be committed to. Equal to `base_branch` for the
    /// default direct push.
    pub branch: String,
    /// The ref this catalogue was pulled from, falling back to the repository default.
    pub base_branch: String,
    /// What a branch would be called if the user asks for a pull request without
    /// naming one. A pure function of the filename, so it stays true no matter which
    /// checkboxes move — which is why `will_open_pr` is deliberately *not* here.
    /// Putting a request-dependent field on the plan would stale it on every click and
    /// force a network round trip per toggle.
    pub suggested_branch: String,
    /// Every branch in the clone, for the dialog's branch picker. Free — the clone is
    /// already open here — and it replaces a `matching-refs` request per keystroke.
    /// Empty when the refs could not be read: a picker with no suggestions still lets
    /// the user type a new branch name, which is the primary use.
    pub branches: Vec<String>,
    /// Git blob SHA of the bytes that would be committed.
    pub local_blob_sha: String,
    /// The same path's blob SHA on `base_branch`, so the dialog can say "nothing to
    /// push" without asking for the file text. `None` — the path is not there yet, so
    /// this push creates it.
    ///
    /// Deliberately against `base_branch` rather than `branch`: the plan is not
    /// re-fetched when the branch field moves, so a verdict about some other branch
    /// would go stale the moment it was useful. The push dialog's `publish_diff`
    /// answers for the branch actually chosen.
    pub base_blob_sha: Option<String>,
    /// True when the account cannot push to the upstream, so the commit lands on a
    /// fork. `can_push_upstream` used to sit beside this as its literal negation; the
    /// only thing that ever read it was the commit-to-base checkbox this replaced.
    pub fork_needed: bool,
    /// The content becomes public and permanent; drives the exposure warning.
    pub target_is_public: bool,
    pub content_bytes: usize,
    /// `[meta].version` as the parser sees it — 1 when the key is absent, matching
    /// `Meta`'s own default. A fact about the local file, like `content_bytes` beside
    /// it, so it cannot go stale as checkboxes move; it is what lets the bump checkbox
    /// name the numbers ("3 → 4") before it is ticked, which is what makes a
    /// default-on checkbox defensible.
    pub meta_version: u32,
    /// Empty when the catalogue is valid; publishing is blocked otherwise.
    pub validation_errors: Vec<String>,
    pub secret_findings: Vec<SecretFinding>,
    pub transmit_frame_count: usize,
    /// Set when this catalogue already has a pull request open.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub existing_pr_url: Option<String>,
}

/// What to compare, for the push dialog's diff tab.
///
/// Everything is named explicitly rather than re-derived. The caller already holds a
/// [`PublishPlan`], and re-deriving would mean the `get_repo` request and the fetch
/// that [`resolve`] does — the exact round trip this command exists to avoid.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishDiffRequest {
    /// Local catalogue filename in the decoder directory. The bytes are read from
    /// disk, never from the editor buffer, so the comparison is against what a push
    /// would actually send.
    pub filename: String,
    pub repo_url: String,
    pub target_path: String,
    /// The branch that would actually be committed to.
    pub branch: String,
    /// What that branch would be created off, when it does not exist yet.
    pub base_branch: String,
}

/// What a push would change upstream, ready to render.
///
/// Carries the rendered diff rather than the two texts. Both are already in hand here,
/// and the diff is the same crate's `catalog::diff_lines` — returning the texts instead
/// would ship them to the frontend and straight back over the WebSocket to be diffed by
/// the function that was one call away.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishDiff {
    /// The ref actually read. Echoed so the tab can label the comparison honestly when
    /// it fell back from a branch that does not exist yet.
    pub compared_ref: String,
    pub branch_exists: bool,
    pub target_path: String,
    /// Unified diff rows, upstream → local, so an `add` is what this push would add.
    /// Empty when `identical`, which the tab renders as a banner rather than a page of
    /// unchanged lines.
    pub lines: Vec<crate::catalog::DiffRow>,
    pub added: usize,
    pub removed: usize,
    /// False when this push would add the file rather than change it.
    pub exists: bool,
    /// Byte-identical, so the commit would be empty.
    pub identical: bool,
    /// Upstream has moved on from the `synced_sha` this catalogue was imported at, so
    /// pushing replaces a change that was never pulled.
    pub upstream_moved: bool,
    /// The last upstream commit to touch this path. `None` when it is not upstream yet
    /// or the walk found nothing within its bound.
    pub last_change: Option<git::FileCommit>,
}

/// A resolved plan plus everything the publish path needs, so it does not repeat the
/// parse, the repository lookup or the disk read that produced it.
struct Resolved {
    plan: PublishPlan,
    /// The clone, already fetched — resolving the base branch needs one anyway, and
    /// the publish path would otherwise fetch the same repository a second time
    /// microseconds later.
    clone_dir: std::path::PathBuf,
    /// Read once here rather than at each of the three places below that need it;
    /// `stored_token` is a synchronous keyring call, which is OS IPC.
    token: Option<String>,
    /// The exact bytes to commit. Deliberately not on `PublishPlan`: the dialog shows
    /// only the byte count, so shipping up to 2 MB of TOML over IPC bought nothing.
    content: String,
    source: CatalogSource,
    client: GitHubClient,
    upstream: RepoInfo,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum PublishAction {
    Created,
    Updated,
    Committed,
}

/// What a version bump did, when one was applied.
///
/// One struct rather than three fields on [`PublishResult`], so "from", "to" and
/// "did it reach the disk" cannot be reported apart.
#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VersionBump {
    pub from: u32,
    pub to: u32,
    /// False when the local file changed while the push was in flight, so the bumped
    /// bytes are upstream but not on disk. The catalogue then reads as locally ahead,
    /// which is honest — those local edits really are not upstream.
    pub written_locally: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishResult {
    pub action: PublishAction,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pr_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pr_number: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub commit_url: Option<String>,
    pub head_owner: String,
    pub branch: String,
    pub reused_branch: bool,
    /// `None` means no bump was asked for. A bump that was asked for but *withheld*
    /// because the push would have changed nothing never reaches a result at all —
    /// `push_blocking` refuses the unchanged tree first.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version_bump: Option<VersionBump>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProgressEvent {
    request_id: String,
    step: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    detail: Option<String>,
}

fn emit(app: &AppHandle, request_id: &str, step: &'static str, detail: Option<String>) {
    let _ = app.emit(
        PROGRESS_EVENT,
        ProgressEvent {
            request_id: request_id.to_string(),
            step,
            detail,
        },
    );
}

// ── Backend ──────────────────────────────────────────────────────────────────

/// Where the branch and commit go.
#[derive(Debug, Clone)]
pub struct HeadRepo {
    pub owner: String,
    pub repo: String,
    /// False when the head is the upstream itself (direct push access).
    pub is_fork: bool,
}

/// A pull request as the publish flow sees it.
pub struct PublishedPull {
    pub number: u64,
    pub url: String,
    /// The PR already existed, so this publish added a commit to it.
    pub existed: bool,
}

/// Resolve the fork to push to, creating it if the user does not have one yet.
///
/// Only reached without push access to the upstream. Every step is idempotent: an
/// existing fork is reused, and a fork mid-creation is waited for rather than
/// duplicated, so recovery from a failure is pressing Publish again.
async fn ensure_fork(
    client: &GitHubClient,
    upstream: &RepoInfo,
    login: &str,
    known_fork: Option<ForkRef>,
) -> Result<HeadRepo, ShareError> {
    if !upstream.allow_forking {
        return Err(ShareError::new(
            ShareErrorKind::Forbidden,
            format!(
                "{} does not allow forks and you do not have push access — \
                 ask a maintainer for access",
                upstream.full_name
            ),
        ));
    }

    // Is this repository a fork of the upstream we mean? Name alone is not enough —
    // the user may own an unrelated repository of the same name.
    async fn confirm(client: &GitHubClient, owner: &str, repo: &str, upstream: &RepoInfo) -> bool {
        matches!(
            client.get_repo(owner, repo).await,
            Ok(candidate)
                if candidate.fork
                    && candidate.parent_full_name.as_deref() == Some(&upstream.full_name)
        )
    }

    // Prefer the fork we recorded last time; only then guess the name.
    let candidates = known_fork
        .iter()
        .map(|f| (f.owner.clone(), f.repo.clone()))
        .chain(std::iter::once((
            login.to_string(),
            upstream.name.clone(),
        )));
    for (owner, repo) in candidates {
        if confirm(client, &owner, &repo, upstream).await {
            return Ok(HeadRepo {
                owner,
                repo,
                is_fork: true,
            });
        }
    }

    let full_name = client.create_fork(&upstream.owner, &upstream.name).await?;
    let (owner, repo) = full_name.split_once('/').ok_or_else(|| {
        ShareError::invalid(format!(
            "GitHub returned an unexpected fork name: {full_name}"
        ))
    })?;

    // Forking is eventually consistent. Poll immediately, then back off.
    for delay in std::iter::once(&0).chain(FORK_POLL_BACKOFF) {
        if *delay > 0 {
            tokio::time::sleep(Duration::from_millis(*delay)).await;
        }
        if client.get_repo(owner, repo).await.is_ok() {
            return Ok(HeadRepo {
                owner: owner.to_string(),
                repo: repo.to_string(),
                is_fork: true,
            });
        }
    }
    Err(ShareError::network(format!(
        "GitHub is still creating the fork {full_name}. Try publishing again in a moment."
    )))
}


// ── Commands ─────────────────────────────────────────────────────────────────

/// What publishing would do, with nothing written.
#[tauri::command(rename_all = "camelCase")]
pub async fn preflight_publish(
    app: AppHandle,
    req: PublishRequest,
) -> Result<PublishPlan, ShareError> {
    Ok(enrich_for_dialog(resolve(&app, &req).await?).await.plan)
}

/// Fill the plan fields only the dialog reads.
///
/// Separate from [`resolve`], which the publish path shares: the branch list, the local
/// hash and the base hash exist for the branch picker and the "nothing to push"
/// verdict, and filling them there cost every push two repository opens and a full ref
/// enumeration for values it drops unserialised.
async fn enrich_for_dialog(mut resolved: Resolved) -> Resolved {
    let plan = &mut resolved.plan;
    plan.branches = git::branches(&resolved.clone_dir).await.unwrap_or_default();
    plan.local_blob_sha = super::registry::git_blob_sha(resolved.content.as_bytes());
    // The tree entry id, not the file: this only feeds an equality test, so inflating
    // up to 2 MB to hash it would be work thrown away. Absent for a path that is not
    // upstream yet, which the dialog reads as "this push adds the file".
    plan.base_blob_sha = git::blob_sha(&resolved.clone_dir, &plan.base_branch, &plan.target_path)
        .await
        .ok()
        .flatten();
    resolved
}

/// The upstream copy of the file this push would land on, beside the local bytes.
///
/// Deliberately **not** part of [`PublishPlan`]. The plan is fetched on every target
/// change, so putting up to 2 MB of TOML on it would make a tab the user may never open
/// a mandatory cost on the path that has to stay fast. It is also deliberately not
/// re-planned when the branch and path controls move (see [`PublishPlan::suggested_branch`]),
/// whereas the right baseline for a diff *is* a function of exactly those controls.
///
/// Answered entirely from the clone [`preflight_publish`] already fetched: this parses
/// the URL and reads the object database, and touches no network at all.
#[tauri::command(rename_all = "camelCase")]
pub async fn publish_diff(
    app: AppHandle,
    req: PublishDiffRequest,
) -> Result<PublishDiff, ShareError> {
    // Parsed and host-checked, and no further. `open_source` would also read the
    // keychain to build a GitHubClient — synchronous OS IPC, on the async runtime,
    // once per debounced keystroke — for a client nothing on this path can use.
    let source = super::url::parse_catalog_source(&req.repo_url)
        .map_err(|e| ShareError::invalid(e.message()))?;
    github::require_supported_host(&source)?;
    let repo_id = source.repo_id();
    let dir = git::clone_dir(&app, &repo_id)?;

    let local_toml = read_local_catalogue(&app, &req.filename)?;
    let local_blob_sha = super::registry::git_blob_sha(local_toml.as_bytes());

    // One open, one ref resolution, serving the blob read and the history walk both.
    let upstream = git::path_at_ref(&dir, &req.branch, &req.base_branch, &req.target_path).await?;
    let remote_sha = upstream.blob.as_ref().map(|b| b.sha.as_str());
    let exists = remote_sha.is_some();
    let identical = remote_sha == Some(local_blob_sha.as_str());

    // "Upstream moved" is only answerable for a catalogue tracked against *this*
    // repository: `synced_sha` records the bytes last exchanged with it, so comparing
    // it to an unrelated repository's blob would be noise.
    let upstream_moved = app
        .state::<CatalogSourceRegistry>()
        .read(&app, |r| {
            r.catalog_for(&req.filename, &repo_id)
                .map(|c| c.synced_sha.clone())
        })
        .zip(remote_sha)
        .is_some_and(|(synced, remote)| synced != remote);

    // Skipped when identical: the tab says so in one line rather than rendering the
    // whole catalogue as unchanged context, so computing an O(n·m) LCS to produce rows
    // nothing draws would be the most expensive no-op in the dialog.
    let lines = if identical {
        Vec::new()
    } else {
        let remote_toml = upstream.blob.as_ref().map(|b| b.text.as_str()).unwrap_or("");
        crate::catalog::diff_lines(remote_toml, &local_toml)
    };
    // One pass: asking twice walks the rows twice for two numbers read side by side.
    let (added, removed) = lines.iter().fold((0, 0), |(add, rm), row| match row.kind {
        DiffKind::Add => (add + 1, rm),
        DiffKind::Remove => (add, rm + 1),
        DiffKind::Context => (add, rm),
    });

    Ok(PublishDiff {
        compared_ref: upstream.resolved_ref,
        branch_exists: upstream.used_preferred,
        target_path: req.target_path,
        last_change: upstream.last_change,
        lines,
        added,
        removed,
        exists,
        identical,
        upstream_moved,
    })
}

/// Publish the catalogue: commit, push, and optionally open a pull request.
#[tauri::command(rename_all = "camelCase")]
pub async fn publish_catalog(
    app: AppHandle,
    req: PublishRequest,
) -> Result<PublishResult, ShareError> {
    emit(&app, &req.request_id, "validate", None);
    // Resolved once, so the repository lookup, disk read and parse are not repeated.
    // The re-read is deliberate even though the dialog just ran a preflight: the file
    // could have changed since, and re-scanning is what stops an edited-in secret
    // slipping past the acknowledgement.
    let Resolved {
        plan,
        clone_dir,
        token,
        content,
        source,
        client,
        upstream,
    } = resolve(&app, &req).await?;

    if !plan.validation_errors.is_empty() {
        return Err(ShareError::invalid(format!(
            "This catalogue is not valid, so it will not be published: {}",
            plan.validation_errors.join("; ")
        )));
    }
    if !plan.secret_findings.is_empty() && !req.accept_secret_findings {
        return Err(ShareError::invalid(format!(
            "{} possible secret(s) found in the file. Review them and confirm before publishing.",
            plan.secret_findings.len()
        )));
    }

    emit(&app, &req.request_id, "auth", None);
    let login = auth_login(&app, &client, &source.host).await?;
    let repo_id = source.repo_id();

    // Without push access the commit has to land on the user's own fork. That is true
    // whether or not they want a pull request — pushing to a fork and stopping is a
    // legitimate "park this somewhere I control".
    let head = if plan.fork_needed {
        emit(&app, &req.request_id, "fork", None);
        let known_fork = app
            .state::<CatalogSourceRegistry>()
            .read(&app, |r| r.repo(&repo_id).and_then(|e| e.fork.clone()));
        let head = ensure_fork(&client, &upstream, &login, known_fork).await?;
        emit(
            &app,
            &req.request_id,
            "fork",
            Some(format!("{}/{}", head.owner, head.repo)),
        );
        head
    } else {
        HeadRepo {
            owner: upstream.owner.clone(),
            repo: upstream.name.clone(),
            is_fork: false,
        }
    };

    // A branch step only when a branch is actually created, so the checklist never
    // reports work that did not happen. The default push has no branch step at all.
    let creating_branch = plan.branch != plan.base_branch;
    if creating_branch {
        emit(&app, &req.request_id, "branch", Some(plan.branch.clone()));
    }

    let saved_sha = super::registry::git_blob_sha(content.as_bytes());
    // Only worth an open when a bump was actually asked for. Read against the same
    // parent `push_blocking` commits onto, so the two cannot disagree about whether
    // this push is a no-op. A read failure degrades to no bump rather than failing the
    // publish: `commit_and_push` is about to open the same repository and would report
    // the real problem.
    let parent_sha = match req.bump_version {
        false => None,
        true => git::blob_sha_at_push_parent(
            &clone_dir,
            &plan.branch,
            &plan.base_branch,
            &plan.target_path,
        )
        .await
        .unwrap_or_else(|e| {
            tlog!("[catalog_share] could not read the push parent: {}", e.message);
            None
        }),
    };
    // Withheld when the push would change nothing on its own — see `bump_applies` —
    // and silently skipped when the file cannot carry one. A bump is a convenience; it
    // must never fail the push it is decorating.
    let bump = bump_applies(req.bump_version, &saved_sha, parent_sha.as_deref())
        .then(|| match wiretap_catalog::edit::bump_meta_version(&content) {
            Ok(bumped) => Some(bumped),
            Err(e) => {
                tlog!("[catalog_share] no version bump for {}: {}", req.filename, e);
                None
            }
        })
        .flatten();
    let content = bump.as_ref().map_or(content, |b| b.text.clone());

    emit(&app, &req.request_id, "commit", None);
    let pushed = git::commit_and_push(
        &app,
        &repo_id,
        &clone_dir,
        &git::PushSpec {
            branch: plan.branch.clone(),
            base: plan.base_branch.clone(),
            path: plan.target_path.clone(),
            content: content.into_bytes(),
            message: req.commit_message.clone(),
            author_name: login.clone(),
            // GitHub's noreply address keeps a real email out of a public commit while
            // still attributing it to the account that pushed.
            author_email: format!("{login}@users.noreply.github.com"),
            push_url: head
                .is_fork
                .then(|| format!("https://{}/{}/{}", source.host, head.owner, head.repo)),
        },
        token.as_deref(),
    )
    .await?;

    let (action, pull) = if req.open_pr {
        emit(&app, &req.request_id, "pr", None);
        let spec = github::PullSpec {
            head_owner: head.owner.clone(),
            branch: plan.branch.clone(),
            base: plan.base_branch.clone(),
            title: if req.pr_title.trim().is_empty() {
                req.commit_message.clone()
            } else {
                req.pr_title.clone()
            },
            body: req.pr_body.clone(),
            draft: req.draft,
        };
        // Look before you leap: the push just updated any open PR on this branch, so
        // creating a second would be wrong.
        let pull = match client
            .find_open_pull(&upstream.owner, &upstream.name, &spec.head_owner, &spec.branch, &spec.base)
            .await?
        {
            Some(existing) => PublishedPull {
                number: existing.number,
                url: existing.html_url,
                existed: true,
            },
            None => {
                let created = client
                    .create_pull(&upstream.owner, &upstream.name, &spec)
                    .await?;
                PublishedPull {
                    number: created.number,
                    url: created.html_url,
                    existed: false,
                }
            }
        };
        let action = if pull.existed {
            PublishAction::Updated
        } else {
            PublishAction::Created
        };
        (action, Some(pull))
    } else {
        (PublishAction::Committed, None)
    };

    // The bumped bytes go to disk only now the push has succeeded, so a failed push
    // leaves the file alone. Ordered before `persist_publish_state`, which rebuilds the
    // catalogue cache: refreshing first would cache a row computed from the old bytes,
    // and on iOS there is no watcher to correct it.
    let version_bump = bump.map(|bump| VersionBump {
        from: bump.from,
        to: bump.to,
        written_locally: write_bumped_file(&app, &req.filename, &saved_sha, &bump.text),
    });

    // The committed blob sha becomes synced_sha, which is what immediately makes the
    // local file read as in sync rather than locally ahead — and, when this push is
    // the first thing to link the file to this repository, records the subscription
    // that makes it read as anything but `localOnly` at all.
    persist_publish_state(
        &app,
        Published {
            filename: &req.filename,
            source: &source,
            upstream: &upstream,
            target_path: &plan.target_path,
            base_branch: &plan.base_branch,
            branch: &plan.branch,
            blob_sha: &pushed.blob_sha,
            pull: pull.as_ref(),
            fork: head.is_fork.then(|| ForkRef {
                owner: head.owner.clone(),
                repo: head.repo.clone(),
            }),
        },
    );

    emit(&app, &req.request_id, "done", None);
    Ok(PublishResult {
        action,
        pr_url: pull.as_ref().map(|p| p.url.clone()),
        pr_number: pull.as_ref().map(|p| p.number),
        // Built from the pushed commit rather than returned by an API, which is why it
        // is available for a plain push and not only for a pull request.
        commit_url: Some(format!(
            "https://{}/{}/{}/commit/{}",
            source.host, head.owner, head.repo, pushed.commit
        )),
        head_owner: head.owner,
        branch: plan.branch,
        reused_branch: creating_branch && !pushed.created_branch,
        version_bump,
    })
}

/// Create a repository to publish into, for someone with nowhere to put their work.
#[tauri::command(rename_all = "camelCase")]
pub async fn create_catalog_repo(req: NewRepo) -> Result<RepoInfo, ShareError> {
    if req.name.trim().is_empty() {
        return Err(ShareError::invalid("Enter a repository name"));
    }
    let token = auth::require_token(github::SUPPORTED_HOST)?;
    GitHubClient::new(Some(token)).create_repo(&req).await
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/// Resolve everything publishing needs: the parsed source, an authenticated client,
/// the upstream repository, the file's bytes, and the derived plan.
async fn resolve(app: &AppHandle, req: &PublishRequest) -> Result<Resolved, ShareError> {
    let (source, client) = super::open_source(&req.repo_url)?;
    // Checked before the network call, so an unauthenticated attempt does not spend a
    // request to discover it needs a token.
    if !client.is_authenticated() {
        return Err(ShareError::new(
            ShareErrorKind::Auth,
            "Connect a GitHub account to publish — Settings → Catalogs",
        ));
    }

    let content = read_local_catalogue(app, &req.filename)?;
    let described = super::describe_catalog(&req.filename, "", &content);
    let upstream = client.get_repo(&source.owner, &source.repo).await?;

    let repo_id = source.repo_id();
    let token = auth::stored_token(&source.host);
    // One fetch serves the base-branch check below and the commit that follows.
    let clone_dir = git::sync(
        app,
        &git::RepoSpec::for_source(&source, &upstream.default_branch),
    )
    .await?
    .dir;
    let (provenance, saved_directory) = app.state::<CatalogSourceRegistry>().read(app, |r| {
        (
            // Scoped to the repository being published to: a catalogue tracked
            // against one repository and published into a *different* one must not
            // inherit the first one's remote path, and — now that the base branch
            // comes from the same entry — nor its commit target.
            r.catalog_for(&req.filename, &repo_id)
                .map(|c| {
                    (
                        c.remote_path.clone(),
                        c.git_ref.clone(),
                        c.publish.clone(),
                    )
                }),
            r.saved_repos
                .iter()
                .find(|s| s.id == repo_id)
                .and_then(|s| s.directory.clone()),
        )
    });
    // Provenance outranks the saved directory: a catalogue that came from
    // `decoders/x.toml` must go back there, or publishing adds a second copy
    // elsewhere in someone else's repository instead of updating the file.
    let target_path = req
        .target_path
        .clone()
        .or_else(|| provenance.as_ref().map(|(path, _, _)| path.clone()))
        .unwrap_or_else(|| {
            let dir = saved_directory
                .as_deref()
                .map(|d| d.trim_matches('/'))
                .filter(|d| !d.is_empty())
                .unwrap_or("catalogs");
            format!("{dir}/{}", req.filename)
        });

    // Push back to the ref this catalogue came from, not blindly to the repository
    // default: a decoder pulled from `v2-dev` belongs on `v2-dev`. Only a branch can
    // be a push target, so a catalogue pinned to a tag or a commit falls back. The
    // lookup sits inside the guard so the common case — no provenance, or provenance
    // already on the default branch — touches the repository not at all.
    let provenance_ref = provenance.as_ref().map(|(_, git_ref, _)| git_ref.clone());
    let base_branch = match provenance_ref {
        Some(git_ref)
            if git_ref != upstream.default_branch
                && git::has_branch(&clone_dir, &git_ref).await =>
        {
            git_ref
        }
        _ => upstream.default_branch.clone(),
    };

    let suggested_branch = default_branch_name(&req.filename);
    let branch = req
        .branch
        .clone()
        .map(|b| b.trim().to_string())
        .filter(|b| !b.is_empty())
        // Reuse the branch a previous publish opened a PR on, so a second edit adds a
        // commit to the review under way instead of opening a rival PR on a different
        // branch that `find_open_pull` would never match.
        .or_else(|| {
            provenance
                .as_ref()
                .and_then(|(_, _, publish)| publish.as_ref())
                .filter(|p| !p.merged && p.pr_number.is_some())
                .and_then(|p| p.branch.clone())
        })
        .or_else(|| req.open_pr.then(|| suggested_branch.clone()))
        .unwrap_or_else(|| base_branch.clone());

    // Kept as a validation error rather than an `Err`: erroring here would return no
    // plan at all, hiding the very `base_branch` the user needs to see to fix it.
    let mut validation_errors = described.errors.clone();
    if req.open_pr && branch == base_branch {
        validation_errors.push(format!(
            "A pull request needs its own branch — '{base_branch}' is the branch it \
             would be opened against. Name a different branch, or turn off the pull \
             request to push straight to '{base_branch}'."
        ));
    }

    let plan = PublishPlan {
        upstream: upstream.full_name.clone(),
        target_path,
        branch,
        base_branch,
        suggested_branch,
        // Filled by `enrich_for_dialog`, which only the preflight runs. `resolve` is
        // shared with the publish path, and that path reads none of the three.
        branches: Vec::new(),
        local_blob_sha: String::new(),
        base_blob_sha: None,
        fork_needed: !upstream.can_push,
        target_is_public: !upstream.private,
        content_bytes: content.len(),
        meta_version: described.meta_version,
        validation_errors,
        secret_findings: secrets::scan(&content),
        transmit_frame_count: described.transmit_frame_count,
        existing_pr_url: provenance.and_then(|(_, _, publish)| publish.and_then(|p| p.pr_url)),
    };

    Ok(Resolved {
        plan,
        clone_dir,
        token,
        content,
        source,
        client,
        upstream,
    })
}

/// Where a catalogue lives, through the shared sanitiser.
///
/// One owner for the read and the write both, so the bytes a bump was derived from and
/// the file it is written back to can never resolve differently.
fn local_catalogue_path(app: &AppHandle, filename: &str) -> Result<PathBuf, ShareError> {
    let name = crate::catalog::sanitise_catalog_filename(filename).map_err(ShareError::invalid)?;
    let dir = crate::catalog::decoder_dir(app)
        .ok_or_else(|| ShareError::invalid("The decoder directory is not available"))?;
    Ok(dir.join(name))
}

/// Read the catalogue from disk — never the editor buffer, so what is published is
/// what was saved. There is no code path by which the buffer could reach here.
fn read_local_catalogue(app: &AppHandle, filename: &str) -> Result<String, ShareError> {
    let path = local_catalogue_path(app, filename)?;
    std::fs::read_to_string(&path)
        .map_err(|e| ShareError::not_found(format!("Could not read {}: {e}", path.display())))
}

/// Write the bumped catalogue back, but only over the exact bytes it was derived from.
///
/// The same unconditional compare `apply_catalog_update` makes before overwriting a
/// reviewed file: a catalogue edited while the push was in flight is left entirely
/// alone. A refused write costs a version number; clobbering costs work.
///
/// No backup, unlike `install_update`: a backup exists to protect work an upstream copy
/// is about to destroy, and what is written here is the bytes already on disk plus one
/// integer — which the guard has just proved.
///
/// Reports whether it landed. Never an error: the push has already succeeded, and
/// failing here would invite a retry that the unchanged-tree rule would then refuse,
/// which is a confusing way to say "your file changed".
fn write_bumped_file(app: &AppHandle, filename: &str, expected_sha: &str, bumped: &str) -> bool {
    let Ok(path) = local_catalogue_path(app, filename) else {
        return false;
    };
    if super::registry::git_blob_sha_of_file(&path).as_deref() != Some(expected_sha) {
        tlog!(
            "[catalog_share] {} changed while publishing; the version bump was not written back",
            filename
        );
        return false;
    }
    match crate::catalog::write_file_atomically(&path, bumped.as_bytes()) {
        Ok(()) => true,
        Err(e) => {
            tlog!("[catalog_share] could not write the bumped {}: {}", filename, e);
            false
        }
    }
}

async fn auth_login(
    app: &AppHandle,
    client: &GitHubClient,
    host: &str,
) -> Result<String, ShareError> {
    // Prefer the cached login; fall back to a round trip when it is absent or stale.
    if let Some(login) = app
        .state::<CatalogSourceRegistry>()
        .read(app, |r| r.identity.clone())
        .filter(|i| i.host == host)
        .map(|i| i.login)
    {
        return Ok(login);
    }
    let identity = client.get_authenticated_identity(host).await?;
    let login = identity.login.clone();
    app.state::<CatalogSourceRegistry>()
        .write(app, |r| r.identity = Some(identity));
    Ok(login)
}

/// Everything a completed push has to record.
struct Published<'a> {
    filename: &'a str,
    source: &'a CatalogSource,
    upstream: &'a RepoInfo,
    /// The path actually committed to.
    target_path: &'a str,
    /// The ref the commit landed on, and the one the subscription records.
    base_branch: &'a str,
    /// The branch pushed to, which may be a pull-request branch.
    branch: &'a str,
    blob_sha: &'a str,
    pull: Option<&'a PublishedPull>,
    fork: Option<ForkRef>,
}

/// The subscription a push produces, from the one it replaces (if any).
///
/// Pure, and split out for exactly that reason: this is the function whose absence
/// meant a push to an untracked catalogue silently recorded nothing at all.
///
/// **`git_ref` is the base branch, not the branch pushed to.** A pull-request branch
/// is ephemeral and may live only on the user's fork, so it is not on
/// `refs/remotes/origin/{ref}` of the upstream clone the update check reads — an
/// entry naming one would never see an update again. It would also come back as the
/// *next* publish's base (`resolve` reads `git_ref` for that), which then trips the
/// "a pull request needs its own branch" refusal. The branch is already recorded in
/// `PublishState.branch`, where the next publish reuses it; a copy in `git_ref` would
/// be the lower-authority one.
///
/// A consequence worth naming: a catalogue pinned to a tag is re-pointed to the
/// branch the commit landed on, because only a branch can be a push target and
/// `synced_sha` must describe a ref we can read back.
fn published_entry(spec: &Published<'_>, previous: Option<&CatalogEntry>) -> CatalogEntry {
    let mut entry = CatalogEntry::new(
        &spec.source.repo_id(),
        spec.target_path,
        spec.base_branch,
        spec.filename,
    );
    entry.mark_exchanged(spec.blob_sha.to_string());
    // A push does not reset a subscription's age.
    if let Some(previous) = previous {
        entry.imported_at = previous.imported_at.clone();
    }

    // An open pull request survives a push that did not ask for one. Overwriting it
    // wholesale dropped `pr_number`, after which `open_pulls` stopped polling and the
    // merge was never noticed — and a merge is the thing the user is waiting to see.
    let carried = previous
        .and_then(|p| p.publish.as_ref())
        .filter(|p| spec.pull.is_none() && p.branch.as_deref() == Some(spec.branch));
    entry.publish = Some(PublishState {
        branch: Some(spec.branch.to_string()),
        pr_number: spec.pull.map(|p| p.number).or(carried.and_then(|c| c.pr_number)),
        pr_url: spec
            .pull
            .map(|p| p.url.clone())
            .or(carried.and_then(|c| c.pr_url.clone())),
        merged: false,
    });
    entry
}

fn persist_publish_state(app: &AppHandle, spec: Published<'_>) {
    let repo_id = spec.source.repo_id();
    // A push moves `synced_sha` — and may create the subscription — without writing to
    // the decoder directory, so the catalogue list's sync status would stay on
    // "local ahead" (or "local only") until something else happened to invalidate the
    // cache.
    super::write_then_refresh(app, |r| {
        // The repository entry first: `set_fork` is update-only, and until now a
        // `RepoEntry` was only ever born of a browse — so a push to a saved but
        // never-browsed repository had nothing to set the fork on. Through
        // `repo_entry` rather than hand-rolled, or the row loses `web_url` and with
        // it Settings' "open the repository" action.
        r.upsert_repo(super::repo_entry(spec.source, spec.upstream));
        // Recorded so the next publish reuses this fork instead of re-probing.
        if let Some(fork) = spec.fork.clone() {
            r.set_fork(&repo_id, fork);
        }
        let previous = r.catalog_for(spec.filename, &repo_id).cloned();
        r.upsert_catalog(published_entry(&spec, previous.as_ref()));
    });
}

/// Is a version bump warranted for this push?
///
/// **A bump alone is not a pushable change.** A commit whose entire diff is
/// `version = 3 → 4` says nothing, and `git::push_blocking` is right to refuse an
/// unchanged tree — so the bump must not be the thing that rescues a push from that
/// refusal. Withholding it here is what keeps that invariant alive: bump
/// unconditionally and the tree always differs by one line, and the refusal can never
/// fire again.
///
/// `parent_blob_sha` is `None` when the path is not upstream yet, which is a genuine
/// change.
fn bump_applies(requested: bool, local_blob_sha: &str, parent_blob_sha: Option<&str>) -> bool {
    requested && parent_blob_sha != Some(local_blob_sha)
}

/// `catalog/{slug}` from the filename stem.
fn default_branch_name(filename: &str) -> String {
    let stem = filename
        .strip_suffix(".toml")
        .unwrap_or(filename)
        .to_lowercase();
    let slug: String = stem
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
    let slug = slug.trim_matches('-').to_string();
    format!(
        "catalog/{}",
        if slug.is_empty() { "update" } else { &slug }
    )
}

#[cfg(test)]
mod tests {
    use super::super::registry::catalog_entry_id;
    use super::*;

    #[test]
    fn branch_name_is_slugged_from_the_filename() {
        assert_eq!(default_branch_name("sbrxxx.toml"), "catalog/sbrxxx");
        assert_eq!(
            default_branch_name("Sungrow SHx.toml"),
            "catalog/sungrow-shx"
        );
        assert_eq!(default_branch_name("weird!!name.toml"), "catalog/weird--name");
        assert_eq!(default_branch_name("---.toml"), "catalog/update");
    }

    /// The default is a direct push to the base branch: no branch named, no pull
    /// request asked for. This is the inversion the whole simplification rests on, so
    /// it is worth pinning rather than leaving to the `serde(default)` attributes.
    #[test]
    fn the_default_request_pushes_to_the_base_branch() {
        let req: PublishRequest = serde_json::from_str(
            r#"{"filename":"x.toml","repoUrl":"https://github.com/o/r","commitMessage":"m"}"#,
        )
        .expect("minimal request deserialises");
        assert!(req.branch.is_none(), "no branch means the base branch");
        assert!(!req.open_pr, "a pull request must be opt-in");
        assert!(!req.draft);
        // The one field that rewrites a file in the decoder directory. The dialog ticks
        // its checkbox on; the *wire* default must stay off, so a caller that predates
        // the field cannot bump by omission.
        assert!(!req.bump_version, "a version bump must be opt-in");
    }

    /// A commit whose entire diff is `version = 3 → 4` says nothing, and
    /// `push_blocking` refuses an unchanged tree. Bump unconditionally and that refusal
    /// can never fire again, because the tree always differs by one line — so the bump
    /// has to be withheld exactly when the push would otherwise be a no-op.
    #[test]
    fn a_bump_is_not_a_pushable_change() {
        assert!(
            !bump_applies(true, "abc", Some("abc")),
            "the parent already holds these bytes, so there is nothing to push"
        );
        assert!(bump_applies(true, "abc", Some("def")), "real content change");
        assert!(
            bump_applies(true, "abc", None),
            "the path is not upstream yet, which is a real change"
        );
        assert!(!bump_applies(false, "abc", Some("def")), "not asked for");
    }

    fn source() -> CatalogSource {
        super::super::url::parse_catalog_source("https://github.com/owner/repo")
            .expect("a plain repository URL parses")
    }

    fn upstream() -> RepoInfo {
        RepoInfo {
            owner: "owner".to_string(),
            name: "repo".to_string(),
            full_name: "owner/repo".to_string(),
            default_branch: "main".to_string(),
            private: false,
            fork: false,
            can_push: true,
            allow_forking: true,
            html_url: "https://github.com/owner/repo".to_string(),
            description: None,
            parent_full_name: None,
        }
    }

    fn published<'a>(
        source: &'a CatalogSource,
        upstream: &'a RepoInfo,
        pull: Option<&'a PublishedPull>,
    ) -> Published<'a> {
        Published {
            filename: "sbrxxx.toml",
            source,
            upstream,
            target_path: "catalogs/sbrxxx.toml",
            base_branch: "main",
            branch: "catalog/sbrxxx",
            blob_sha: "newsha",
            pull,
            fork: None,
        }
    }

    /// The reported bug, at the level it happened: a push to a catalogue nothing was
    /// tracking recorded nothing at all, so the picker kept showing `localOnly` for
    /// ever. Publishing must *create* the subscription, not only update one.
    ///
    /// And it must record the **base branch**, not the branch pushed to. A
    /// pull-request branch may live only on a fork, so it is not on `origin/{ref}` of
    /// the upstream clone the update check reads — an entry naming one would never see
    /// an update again — and `resolve` reads `git_ref` back as the next push's base.
    #[test]
    fn a_publish_to_an_untracked_repository_records_the_base_branch() {
        let (source, upstream) = (source(), upstream());
        let entry = published_entry(&published(&source, &upstream, None), None);

        assert_eq!(entry.git_ref, "main", "the ref pushed to, not the PR branch");
        assert_eq!(
            entry.id,
            catalog_entry_id("gh:owner/repo", "catalogs/sbrxxx.toml", "main")
        );
        assert_eq!(entry.repo_id, "gh:owner/repo");
        assert_eq!(entry.local_filename, "sbrxxx.toml");
        // Both halves move: the file immediately reads as in sync rather than ahead.
        assert_eq!(entry.synced_sha, "newsha");
        assert_eq!(entry.remote_sha.as_deref(), Some("newsha"));
        // The PR branch is recorded where it belongs, and reused by the next publish.
        let publish = entry.publish.expect("a push records its branch");
        assert_eq!(publish.branch.as_deref(), Some("catalog/sbrxxx"));
        assert!(publish.pr_number.is_none());
    }

    /// A push does not reset a subscription's age, and — the part that was a real bug —
    /// does not forget an open pull request just because this push did not ask for one.
    /// Dropping `pr_number` stops `open_pulls` polling it, and the merge, which is what
    /// the user is waiting to see, is never noticed.
    #[test]
    fn a_second_publish_preserves_imported_at_and_an_open_pull_request() {
        let (source, upstream) = (source(), upstream());
        let mut previous = published_entry(&published(&source, &upstream, None), None);
        previous.imported_at = "2020-01-01T00:00:00Z".to_string();
        previous.publish = Some(PublishState {
            branch: Some("catalog/sbrxxx".to_string()),
            pr_number: Some(42),
            pr_url: Some("https://github.com/owner/repo/pull/42".to_string()),
            merged: false,
        });

        let entry = published_entry(&published(&source, &upstream, None), Some(&previous));
        assert_eq!(entry.imported_at, "2020-01-01T00:00:00Z");
        let publish = entry.publish.expect("still recorded");
        assert_eq!(publish.pr_number, Some(42));
        assert!(publish.pr_url.is_some());
    }

    /// …but only for the branch it was opened on. A push to a different branch is not
    /// that review, and carrying the number over would point the row at a pull request
    /// this commit never touched.
    #[test]
    fn a_publish_to_another_branch_does_not_inherit_the_pull_request() {
        let (source, upstream) = (source(), upstream());
        let mut previous = published_entry(&published(&source, &upstream, None), None);
        previous.publish = Some(PublishState {
            branch: Some("catalog/older".to_string()),
            pr_number: Some(42),
            pr_url: Some("https://github.com/owner/repo/pull/42".to_string()),
            merged: false,
        });

        let entry = published_entry(&published(&source, &upstream, None), Some(&previous));
        let publish = entry.publish.expect("still recorded");
        assert_eq!(publish.branch.as_deref(), Some("catalog/sbrxxx"));
        assert!(publish.pr_number.is_none());
    }
}
