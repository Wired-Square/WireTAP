//! The git transport: a real clone per saved repository.
//!
//! This is the only module that knows `git2` exists. Everything above it works in
//! terms of paths, refs, blob SHAs and [`ShareError`], so swapping the library (or
//! adding an SSH backend) does not reach the commands, the dialogs or the registry.
//!
//! ## The clone is transport and mirror, not a workspace
//!
//! WireTAP never leaves a clone divergent. [`sync`] fast-forwards the local branch to
//! `origin`, and **hard-resets it when they have diverged** — which is safe precisely
//! because the clone is not where anything is authored. The content of record lives in
//! the decoder directory; a clone-local commit that never reached the remote is a
//! failed push, not user work, and the file it came from is still sitting in the
//! decoder directory reading as "local ahead". That invariant is what lets this module
//! skip merge, rebase and conflict resolution entirely: when the local file has edits
//! *and* upstream moved, the existing diff review is shown and the user chooses.
//!
//! ## Blocking
//!
//! libgit2 is synchronous, and a clone is not fast. Every public function here is
//! `async` and does its work inside `spawn_blocking` — calling git2 straight from a
//! Tauri command would stall the runtime for the length of a network fetch.
//!
//! ## Credentials
//!
//! HTTPS only, with the token from [`super::auth`]. SSH is deliberately not enabled:
//! the `ssh` feature pulls libssh2 onto all four platforms, and the keychain token
//! already covers every supported host. libgit2's TLS backend differs per platform —
//! SecureTransport on macOS and iOS, WinHTTP on Windows, OpenSSL (vendored) on Linux —
//! which is why `Cargo.toml` splits the feature list per target.

use std::path::{Path, PathBuf};

use git2::{
    build::RepoBuilder, Cred, FetchOptions, PushOptions, RemoteCallbacks, Repository, Signature,
};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

use super::error::{ShareError, ShareErrorKind};
use super::github::{MAX_CANDIDATES, MAX_CATALOG_BYTES};

/// One `.toml` blob found in the repository tree.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TreeBlob {
    pub path: String,
    /// Git blob SHA-1 — the same identifier stored as `synced_sha`, which is what lets
    /// change detection avoid reading content.
    pub sha: String,
    pub size: u64,
}

/// A repository tree listing, already filtered to candidate catalogues.
#[derive(Debug, Clone)]
pub struct TreeListing {
    pub blobs: Vec<TreeBlob>,
    /// Candidates dropped by [`MAX_CANDIDATES`], so the UI never implies it showed
    /// everything. There is no `truncated` counterpart any more: a local tree walk
    /// either sees the whole tree or fails, so the GitHub tree API's "gave up
    /// enumerating" case cannot happen.
    pub dropped: usize,
}

impl TreeListing {
    pub fn blob(&self, path: &str) -> Option<&TreeBlob> {
        self.blobs.iter().find(|b| b.path == path)
    }
}

/// Tauri event carrying clone/fetch progress. A Tauri event rather than a WebSocket
/// push for the same reason publish progress is: it is window-scoped modal UI, and the
/// WS surface has a 10-second timeout a clone would blow straight through.
pub const PROGRESS_EVENT: &str = "catalog-git-progress";

/// Emitted while a clone or fetch is running, so a first browse of a large repository
/// does not look like a hang.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Progress {
    repo_id: String,
    /// `clone` or `fetch` — a first clone is much slower and the UI says so.
    phase: &'static str,
    received_objects: usize,
    total_objects: usize,
    received_bytes: usize,
}

// ── Paths ────────────────────────────────────────────────────────────────────

/// Directory holding every clone, under the app data dir.
///
/// Derived on every call and never persisted: iOS container UUIDs change between
/// installs, which is the same reason `CatalogEntry` stores a filename rather than a
/// path. A stale absolute path in `catalog-sources.json` would be worse than useless.
pub fn repos_root(app: &AppHandle) -> Result<PathBuf, ShareError> {
    app.path()
        .app_data_dir()
        .map(|dir| dir.join("repos"))
        .map_err(|e| ShareError::invalid(format!("No application data directory: {e}")))
}

/// Where one repository's clone lives: `<app_data>/repos/{key}`.
///
/// The key is derived from the registry's `repo_id` (`gh:{owner}/{repo}`) with every
/// character that is not alphanumeric folded to `-`, so it is a single safe path
/// segment on all four platforms — no slashes, and no colons, which Windows rejects.
pub fn clone_dir(app: &AppHandle, repo_id: &str) -> Result<PathBuf, ShareError> {
    Ok(repos_root(app)?.join(clone_key(repo_id)))
}

fn clone_key(repo_id: &str) -> String {
    repo_id
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect()
}

/// Is there a usable clone at this path?
///
/// Deliberately stricter than "the directory exists": an app suspended mid-clone, an
/// OS purge of app data, or a half-restored backup can all leave a directory libgit2
/// cannot open. Everything that syncs treats "not usable" as "clone it again", which
/// is what makes those cases recover with no special handling.
pub fn is_usable(dir: &Path) -> bool {
    Repository::open(dir).is_ok()
}

// ── Errors ───────────────────────────────────────────────────────────────────

/// Map a libgit2 error onto the shared error type, so every hint the UI already
/// renders for a REST failure works for a transport failure too.
pub fn map_err(e: git2::Error) -> ShareError {
    use git2::ErrorClass as Class;
    use git2::ErrorCode as Code;

    let kind = match (e.code(), e.class()) {
        (Code::Auth, _) | (_, Class::Ssl) => ShareErrorKind::Auth,
        (Code::Certificate, _) => ShareErrorKind::Network,
        (Code::NotFound, _) => ShareErrorKind::NotFound,
        (_, Class::Net) | (_, Class::Http) => ShareErrorKind::Network,
        _ => ShareErrorKind::Api,
    };
    // libgit2's messages are specific and user-legible ("authentication required but
    // no callback set", "reference 'refs/heads/x' not found"); surface them rather
    // than inventing our own, exactly as the GitHub client does with API messages.
    ShareError::new(kind, e.message().to_string())
}

/// Run blocking git work off the async runtime.
///
/// libgit2 is synchronous and a fetch is not fast, so every public function here goes
/// through this. Centralised so the join-error mapping — a panicked git task — is
/// described once rather than re-typed at every call site.
async fn blocking<T, F>(f: F) -> Result<T, ShareError>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, ShareError> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| ShareError::invalid(format!("Git task failed: {e}")))?
}

// ── Request / result types ───────────────────────────────────────────────────

/// Everything needed to reach one repository.
#[derive(Debug, Clone)]
pub struct RepoSpec {
    /// Registry key, `gh:{owner}/{repo}` — also the clone directory name.
    pub repo_id: String,
    /// HTTPS clone URL.
    pub clone_url: String,
    /// Branch to track.
    pub git_ref: String,
    /// Keychain token, when there is one. `None` clones anonymously, which is all a
    /// public repository needs.
    pub token: Option<String>,
}

impl RepoSpec {
    /// Reach a repository the registry already knows about.
    ///
    /// The clone URL is rebuilt from the stored identity rather than persisted, so a
    /// repository tracked before clones existed needs no migration.
    pub fn for_repo(repo: &super::registry::RepoEntry, git_ref: &str) -> Self {
        Self {
            repo_id: repo.id.clone(),
            clone_url: repo.repo_url(),
            git_ref: git_ref.to_string(),
            token: super::auth::stored_token(&repo.host),
        }
    }

    /// Reach a repository named by a freshly parsed URL.
    pub fn for_source(source: &super::url::CatalogSource, git_ref: &str) -> Self {
        Self {
            repo_id: source.repo_id(),
            clone_url: source.repo_url(),
            git_ref: git_ref.to_string(),
            token: super::auth::stored_token(&source.host),
        }
    }
}

/// The state of a clone after [`sync`].
#[derive(Debug, Clone)]
pub struct Synced {
    pub dir: PathBuf,
    /// Commit id at `origin/{git_ref}`. Compared against the registry's recorded head
    /// to skip a tree walk that cannot have found anything new.
    pub head: String,
    /// The clone was created by this call rather than fetched. No caller branches on
    /// it — the progress events already carry the phase — but it is what lets the
    /// tests assert that a second sync reuses the clone instead of re-cloning, which
    /// is a guarantee worth holding onto.
    #[allow(dead_code)]
    pub cloned: bool,
}

/// One file's content, read out of the object database.
#[derive(Debug, Clone)]
pub struct BlobText {
    pub text: String,
    /// Git blob SHA-1 — the identifier stored as `synced_sha`.
    pub sha: String,
}

/// What to commit and where.
#[derive(Debug, Clone)]
pub struct PushSpec {
    /// Branch to commit to. Created off `base` when absent.
    pub branch: String,
    /// Branch to create from, when `branch` does not exist yet.
    pub base: String,
    /// Repo-relative path of the file.
    pub path: String,
    pub content: Vec<u8>,
    pub message: String,
    pub author_name: String,
    pub author_email: String,
    /// Push somewhere other than `origin` — the user's fork, when they cannot push to
    /// the upstream. An anonymous remote rather than a saved one, so a fork that is
    /// renamed or deleted cannot leave a stale entry in the user's `git remote -v`.
    pub push_url: Option<String>,
}

#[derive(Debug, Clone)]
pub struct Pushed {
    pub commit: String,
    /// Blob SHA-1 of the committed bytes, which becomes `synced_sha`.
    pub blob_sha: String,
    /// The branch did not exist before this push.
    pub created_branch: bool,
}

// ── Callbacks ────────────────────────────────────────────────────────────────

/// Credentials and progress for one network operation.
///
/// Rebuilt per call rather than shared: `RemoteCallbacks` borrows its closures, and a
/// fetch and a push in the same function each need their own.
/// `progress` is optional so the core is exercisable without a running Tauri app —
/// which is what lets the round-trip test below be a real test rather than a mock.
fn callbacks<'a>(
    token: Option<&'a str>,
    progress: Option<(&'a AppHandle, &'a str, &'static str)>,
) -> RemoteCallbacks<'a> {
    let mut cb = RemoteCallbacks::new();
    cb.credentials(move |_url, username, _allowed| match token {
        // GitHub (and GitLab, and Gitea) accept a PAT as the password with any
        // username. Prefer whatever the URL carried so a host that does care is
        // still served correctly.
        Some(token) => Cred::userpass_plaintext(username.unwrap_or("git"), token),
        // No token: anonymous HTTPS, which is all a public repository needs. Being
        // asked for credentials at all means the repository is private, and saying so
        // is more useful than libgit2's default message.
        None => Err(git2::Error::from_str(
            "This repository needs an account. Connect GitHub in Settings → Catalogs.",
        )),
    });
    if let Some((app, repo_id, phase)) = progress {
        let app = app.clone();
        let repo_id = repo_id.to_string();
        cb.transfer_progress(move |stats| {
            let _ = app.emit(
                PROGRESS_EVENT,
                Progress {
                    repo_id: repo_id.clone(),
                    phase,
                    received_objects: stats.received_objects(),
                    total_objects: stats.total_objects(),
                    received_bytes: stats.received_bytes(),
                },
            );
            true
        });
    }
    cb
}

// ── Sync ─────────────────────────────────────────────────────────────────────

/// Clone if there is no usable clone, else fetch; then bring the local branch in line
/// with `origin`.
///
/// Returns the head commit of the tracked branch, so a caller can skip work when it
/// matches what it recorded last time.
pub async fn sync(app: &AppHandle, spec: &RepoSpec) -> Result<Synced, ShareError> {
    let dir = clone_dir(app, &spec.repo_id)?;
    let app = app.clone();
    let spec = spec.clone();
    blocking(move || sync_blocking(Some(&app), &dir, &spec)).await
}

fn sync_blocking(
    app: Option<&AppHandle>,
    dir: &Path,
    spec: &RepoSpec,
) -> Result<Synced, ShareError> {
    let cloned = !is_usable(dir);
    let repo = if cloned {
        // A directory that exists but will not open is a partial clone — from an app
        // suspended mid-fetch, or a purged container. Start again rather than trying
        // to repair it.
        if dir.exists() {
            std::fs::remove_dir_all(dir)
                .map_err(|e| ShareError::invalid(format!("Could not clear a stale clone: {e}")))?;
        }
        if let Some(parent) = dir.parent() {
            std::fs::create_dir_all(parent).map_err(|e| {
                ShareError::invalid(format!("Could not create the clone directory: {e}"))
            })?;
        }
        let mut fo = FetchOptions::new();
        fo.remote_callbacks(callbacks(
            spec.token.as_deref(),
            app.map(|app| (app, spec.repo_id.as_str(), "clone")),
        ));
        RepoBuilder::new()
            .fetch_options(fo)
            .clone(&spec.clone_url, dir)
            .map_err(map_err)?
    } else {
        let repo = Repository::open(dir).map_err(map_err)?;
        {
            let mut remote = repo.find_remote("origin").map_err(map_err)?;
            let mut fo = FetchOptions::new();
            fo.remote_callbacks(callbacks(
                spec.token.as_deref(),
                app.map(|app| (app, spec.repo_id.as_str(), "fetch")),
            ));
            // Explicit refspec: a clone's configured one is fine, but a repository we
            // may later add a fork remote to should never depend on that.
            remote
                .fetch(
                    &["+refs/heads/*:refs/remotes/origin/*"],
                    Some(&mut fo),
                    None,
                )
                .map_err(map_err)?;
        }
        repo
    };

    if cloned {
        tlog!(
            "[catalog_share] cloned {} into {}",
            spec.repo_id,
            dir.display()
        );
    }

    // Align when the ref is a branch. A tag or a raw commit is read-only — there is no
    // local branch to move, and failing the whole sync over one would make a catalogue
    // pinned to a tag unreadable rather than merely unpushable.
    let head = match align_branch(&repo, &spec.git_ref) {
        Ok(head) => head,
        Err(_) => head_of(&repo, &spec.git_ref)?,
    };
    Ok(Synced {
        dir: dir.to_path_buf(),
        head,
        cloned,
    })
}

/// Point the local branch at `origin/{branch}`.
///
/// Fast-forward, create, or hard-reset — all three collapse to "make local match
/// origin", because the clone is a mirror. See the module docs for why discarding a
/// divergent local commit is safe here.
///
/// Moves the ref only. Checking the working tree out is deliberately **not** done
/// here: every read path (`list_catalogues`, `read_blob`, `known_refs`,
/// `ahead_behind`) resolves out of the object database and never looks at the
/// working tree, so checking out on every sync meant a whole-tree diff — and on a
/// branch switch, rewriting every file — for work that was then thrown away. Only
/// [`push_blocking`] needs a working tree, and it checks out for itself.
fn align_branch(repo: &Repository, branch: &str) -> Result<String, ShareError> {
    let upstream = repo
        .find_reference(&format!("refs/remotes/origin/{branch}"))
        .map_err(|_| {
            ShareError::not_found(format!("The branch '{branch}' is not in this repository"))
        })?
        .peel_to_commit()
        .map_err(map_err)?;
    let head = upstream.id().to_string();

    repo.reference(
        &format!("refs/heads/{branch}"),
        upstream.id(),
        true,
        "wiretap: align with origin",
    )
    .map_err(map_err)?;
    repo.set_head(&format!("refs/heads/{branch}"))
        .map_err(map_err)?;
    Ok(head)
}

// ── Reads ────────────────────────────────────────────────────────────────────

/// Every candidate catalogue at `origin/{git_ref}`, optionally under one directory.
///
/// Unlike the GitHub tree API this cannot be truncated — the whole tree is local — so
/// the only cap left is [`MAX_CANDIDATES`] on what the UI is asked to render.
pub async fn list_catalogues(
    dir: &Path,
    git_ref: &str,
    scope: Option<&str>,
) -> Result<TreeListing, ShareError> {
    let (dir, git_ref, scope) = (
        dir.to_path_buf(),
        git_ref.to_string(),
        scope.map(str::to_string),
    );
    blocking(move || list_blocking(&dir, &git_ref, scope.as_deref())).await
}

fn list_blocking(
    dir: &Path,
    git_ref: &str,
    scope: Option<&str>,
) -> Result<TreeListing, ShareError> {
    let repo = Repository::open(dir).map_err(map_err)?;
    let tree = tree_at(&repo, git_ref)?;
    let prefix = scope
        .map(|s| format!("{}/", s.trim_matches('/')))
        .filter(|s| s != "/");

    let mut blobs = Vec::new();
        let mut dropped = 0usize;
        tree.walk(git2::TreeWalkMode::PreOrder, |root, entry| {
            if entry.kind() != Some(git2::ObjectType::Blob) {
                return git2::TreeWalkResult::Ok;
            }
            // Non-UTF-8 filenames are legal in git and cannot be a catalogue we could
            // write to the decoder directory anyway, so skip rather than fail the walk.
            let Ok(name) = entry.name() else {
                return git2::TreeWalkResult::Ok;
            };
            let path = format!("{root}{name}");
            if !is_candidate_catalog_path(&path) {
                return git2::TreeWalkResult::Ok;
            }
            if let Some(prefix) = &prefix {
                if !path.starts_with(prefix.as_str()) {
                    return git2::TreeWalkResult::Ok;
                }
            }
            if blobs.len() >= MAX_CANDIDATES {
                dropped += 1;
                return git2::TreeWalkResult::Ok;
            }
            // Header only: `find_blob` would decompress every candidate just to read
            // its length, which for a 200-file listing is 200 wasted object loads.
            let size = repo
                .odb()
                .and_then(|odb| odb.read_header(entry.id()))
                .map(|(size, _kind)| size as u64)
                .unwrap_or(0);
            blobs.push(TreeBlob {
                path,
                sha: entry.id().to_string(),
                size,
            });
        git2::TreeWalkResult::Ok
    })
    .map_err(map_err)?;

    Ok(TreeListing { blobs, dropped })
}

/// One file's text at `origin/{git_ref}`.
pub async fn read_blob(dir: &Path, git_ref: &str, path: &str) -> Result<BlobText, ShareError> {
    let (dir, git_ref, path) = (dir.to_path_buf(), git_ref.to_string(), path.to_string());
    blocking(move || read_blob_blocking(&dir, &git_ref, &path)).await
}

fn read_blob_blocking(dir: &Path, git_ref: &str, path: &str) -> Result<BlobText, ShareError> {
    let repo = Repository::open(dir).map_err(map_err)?;
    let tree = tree_at(&repo, git_ref)?;
    let entry = tree
        .get_path(Path::new(path))
        .map_err(|_| ShareError::not_found(format!("{path} is not in this repository")))?;
    let blob = repo.find_blob(entry.id()).map_err(map_err)?;
    if blob.size() as u64 > MAX_CATALOG_BYTES {
        return Err(ShareError::invalid(format!(
            "{path} is larger than the {} MB catalogue limit",
            MAX_CATALOG_BYTES / (1024 * 1024)
        )));
    }
    // Byte-exact, and the blob SHA is over these exact bytes — normalising line
    // endings here would break change detection and be a real diff upstream.
    let text = String::from_utf8(blob.content().to_vec())
        .map_err(|_| ShareError::invalid(format!("{path} is not valid UTF-8")))?;
    Ok(BlobText {
        text,
        sha: entry.id().to_string(),
    })
}

/// How far the local branch is ahead of and behind `origin`.
///
/// The honest version of the question the sync badge asks. `(0, 0)` means in sync.
pub async fn ahead_behind(dir: &Path, branch: &str) -> Result<(usize, usize), ShareError> {
    let (dir, branch) = (dir.to_path_buf(), branch.to_string());
    blocking(move || ahead_behind_blocking(&dir, &branch)).await
}

fn ahead_behind_blocking(dir: &Path, branch: &str) -> Result<(usize, usize), ShareError> {
    let repo = Repository::open(dir).map_err(map_err)?;
    let local = repo
        .find_reference(&format!("refs/heads/{branch}"))
        .and_then(|r| r.peel_to_commit())
        .map_err(map_err)?;
    let upstream = repo
        .find_reference(&format!("refs/remotes/origin/{branch}"))
        .and_then(|r| r.peel_to_commit())
        .map_err(map_err)?;
    repo.graph_ahead_behind(local.id(), upstream.id())
        .map_err(map_err)
}

/// Resolve a ref to a commit, preferring the remote-tracking branch.
///
/// Tags and raw commit ids resolve too, which is what lets a catalogue tracked at a
/// tag still be read even though it can never be a push target. Remote-tracking first
/// so a stale local branch of the same name can never shadow what upstream holds.
fn commit_at<'a>(repo: &'a Repository, git_ref: &str) -> Result<git2::Commit<'a>, ShareError> {
    [
        format!("refs/remotes/origin/{git_ref}"),
        format!("refs/tags/{git_ref}"),
        git_ref.to_string(),
    ]
    .iter()
    .find_map(|candidate| {
        repo.revparse_single(candidate)
            .ok()
            .and_then(|object| object.peel_to_commit().ok())
    })
    .ok_or_else(|| {
        ShareError::not_found(format!(
            "'{git_ref}' is not a branch, tag or commit in this repository"
        ))
    })
}

fn tree_at<'a>(repo: &'a Repository, git_ref: &str) -> Result<git2::Tree<'a>, ShareError> {
    commit_at(repo, git_ref)?.tree().map_err(map_err)
}

fn head_of(repo: &Repository, git_ref: &str) -> Result<String, ShareError> {
    Ok(commit_at(repo, git_ref)?.id().to_string())
}

/// Is `git_ref` a branch in this already-synced clone?
///
/// Used to decide whether a catalogue's provenance ref can be a push target. Treats
/// any failure as "no": this only ever selects between a preferred base branch and the
/// repository default, so a transient error must degrade to the safe default rather
/// than fail the whole preflight.
pub async fn is_branch(dir: &Path, git_ref: &str) -> bool {
    known_refs(dir)
        .await
        .is_ok_and(|refs| refs.iter().any(|name| name == git_ref))
}

/// Short names of every branch and tag the clone knows about.
///
/// Replaces a GitHub `matching-refs` request: once the repository is cloned, the refs
/// are already local, and answering from them works for any host rather than only for
/// the one API we implemented.
pub async fn known_refs(dir: &Path) -> Result<Vec<String>, ShareError> {
    let dir = dir.to_path_buf();
    blocking(move || {
        let repo = Repository::open(&dir).map_err(map_err)?;
        let mut names = Vec::new();
        for reference in repo.references().map_err(map_err)?.flatten() {
            let Ok(name) = reference.name() else { continue };
            // `origin/HEAD` is a symbolic alias, not a ref anyone can ask for by name.
            if let Some(branch) = name.strip_prefix("refs/remotes/origin/") {
                if branch != "HEAD" {
                    names.push(branch.to_string());
                }
            } else if let Some(tag) = name.strip_prefix("refs/tags/") {
                names.push(tag.to_string());
            }
        }
        Ok(names)
    })
    .await
}

// ── Write ────────────────────────────────────────────────────────────────────

/// Stage one file, commit it, and push the branch.
///
/// Creates the branch off `base` when it does not exist, which is the only branching
/// this module does — there is no separate "create a branch" step to get out of step
/// with the commit.
pub async fn commit_and_push(
    app: &AppHandle,
    repo_id: &str,
    dir: &Path,
    spec: &PushSpec,
    token: Option<&str>,
) -> Result<Pushed, ShareError> {
    let (app, repo_id, dir, spec, token) = (
        app.clone(),
        repo_id.to_string(),
        dir.to_path_buf(),
        spec.clone(),
        token.map(str::to_string),
    );
    blocking(move || {
        push_blocking(Some(&app), &repo_id, &dir, &spec, token.as_deref())
    })
    .await
}

fn push_blocking(
    app: Option<&AppHandle>,
    repo_id: &str,
    dir: &Path,
    spec: &PushSpec,
    token: Option<&str>,
) -> Result<Pushed, ShareError> {
    let repo = Repository::open(dir).map_err(map_err)?;

    // Branch off the base when it is new. `align_branch` has already put the base at
    // origin, so the new branch starts from current upstream rather than whatever this
    // clone happened to hold.
    let created_branch = repo
        .find_reference(&format!("refs/heads/{}", spec.branch))
        .is_err();
    if created_branch {
        let base = repo
            .find_reference(&format!("refs/remotes/origin/{}", spec.base))
            .map_err(|_| {
                ShareError::not_found(format!("The base branch '{}' is not available", spec.base))
            })?
            .peel_to_commit()
            .map_err(map_err)?;
        repo.branch(&spec.branch, &base, false).map_err(map_err)?;
    }
    repo.set_head(&format!("refs/heads/{}", spec.branch))
        .map_err(map_err)?;
    // The one place a working tree is actually needed — everything else reads from the
    // object database. Force: the tree is ours, never the user's, so a local
    // modification is debris from an interrupted operation, not something to preserve.
    repo.checkout_head(Some(git2::build::CheckoutBuilder::new().force()))
        .map_err(map_err)?;

    // Write into the working tree, then stage it. Going through the index rather than
    // a TreeBuilder keeps the clone a repository the `git` binary reports as clean.
    let rel = Path::new(&spec.path);
    let target = dir.join(rel);
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| ShareError::invalid(format!("Could not create {}: {e}", spec.path)))?;
    }
    std::fs::write(&target, &spec.content)
        .map_err(|e| ShareError::invalid(format!("Could not write {}: {e}", spec.path)))?;

    let mut index = repo.index().map_err(map_err)?;
    index.add_path(rel).map_err(map_err)?;
    index.write().map_err(map_err)?;
    let tree = repo
        .find_tree(index.write_tree().map_err(map_err)?)
        .map_err(map_err)?;

    let signature = Signature::now(&spec.author_name, &spec.author_email).map_err(map_err)?;
    let parent = repo
        .head()
        .and_then(|h| h.peel_to_commit())
        .map_err(map_err)?;
    let commit = repo
        .commit(
            Some("HEAD"),
            &signature,
            &signature,
            &spec.message,
            &tree,
            &[&parent],
        )
        .map_err(map_err)?;

    // The blob SHA of what we just committed, read back from the tree rather than
    // recomputed, so the stored `synced_sha` is what the repository actually holds.
    let blob_sha = tree
        .get_path(rel)
        .map(|e| e.id().to_string())
        .map_err(map_err)?;

    // libgit2 reports a server-side rejection through this callback and *still*
    // returns Ok from push, so a non-empty message here is the only way to tell a
    // rejected push from a successful one.
    let mut rejection: Option<String> = None;
    // Scoped so the callback's mutable borrow of `rejection` ends before it is read.
    {
        let mut cb = callbacks(token, app.map(|app| (app, repo_id, "push")));
        cb.push_update_reference(|reference, status| {
            if let Some(status) = status {
                rejection = Some(format!("{reference}: {status}"));
            }
            Ok(())
        });
        let mut po = PushOptions::new();
        po.remote_callbacks(cb);
        let mut remote = match &spec.push_url {
            Some(url) => repo.remote_anonymous(url).map_err(map_err)?,
            None => repo.find_remote("origin").map_err(map_err)?,
        };
        remote
            .push(
                &[format!("refs/heads/{0}:refs/heads/{0}", spec.branch)],
                Some(&mut po),
            )
            .map_err(map_err)?;
    }
    if let Some(why) = rejection {
        return Err(ShareError::new(
            ShareErrorKind::Forbidden,
            format!("The remote rejected the push — {why}"),
        ));
    }

    Ok(Pushed {
        commit: commit.to_string(),
        blob_sha,
        created_branch,
    })
}

// ── Candidate filter ─────────────────────────────────────────────────────────

/// Filter out `.toml` files that are obviously not catalogues, so the browse list is
/// not padded with build manifests. Validation is still the real gate; this just keeps
/// the listing honest before anything is read.
fn is_candidate_catalog_path(path: &str) -> bool {
    let lower = path.to_lowercase();
    if !lower.ends_with(".toml") {
        return false;
    }
    const SKIP_DIRS: &[&str] = &[
        ".github",
        ".cargo",
        ".vscode",
        "node_modules",
        "target",
        "dist",
        "build",
        "vendor",
    ];
    const SKIP_FILES: &[&str] = &[
        "cargo.toml",
        "pyproject.toml",
        "rust-toolchain.toml",
        "rustfmt.toml",
        "clippy.toml",
        "netlify.toml",
        "pdm.toml",
        "tauri.conf.toml",
    ];
    let mut segments: Vec<&str> = lower.split('/').collect();
    let basename = segments.pop().unwrap_or("");
    !segments.iter().any(|s| SKIP_DIRS.contains(s)) && !SKIP_FILES.contains(&basename)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clone_key_is_one_safe_path_segment() {
        // Colons and slashes are both illegal or meaningful in a Windows path, and
        // `repo_id` contains both.
        let key = clone_key("gh:wiredsquare/wiretap-decoders");
        assert_eq!(key, "gh-wiredsquare-wiretap-decoders");
        assert!(!key.contains(['/', '\\', ':']));
    }

    #[test]
    fn different_repos_never_share_a_clone_directory() {
        assert_ne!(clone_key("gh:a/b"), clone_key("gh:a/c"));
        assert_ne!(clone_key("gh:a/b"), clone_key("gl:a/b"));
    }

    #[test]
    fn keeps_plausible_catalogue_paths() {
        for path in [
            "sbrxxx.toml",
            "catalogs/sbrxxx.toml",
            "catalogs/sungrow/shx.toml",
            "decoders/OBD2-Standard.TOML",
        ] {
            assert!(is_candidate_catalog_path(path), "{path}");
        }
    }

    #[test]
    fn drops_build_manifests_and_tool_config() {
        for path in [
            "Cargo.toml",
            "src-tauri/Cargo.toml",
            "pyproject.toml",
            "rust-toolchain.toml",
            "rustfmt.toml",
        ] {
            assert!(!is_candidate_catalog_path(path), "{path}");
        }
    }

    #[test]
    fn drops_non_toml_and_vendored_trees() {
        for path in [
            "README.md",
            "Cargo.lock",
            "catalogs/sbrxxx.dbc",
            ".github/workflows/ci.toml",
            "node_modules/thing/config.toml",
            "target/debug/x.toml",
            "web/node_modules/x/y.toml",
        ] {
            assert!(!is_candidate_catalog_path(path), "{path}");
        }
    }

    /// A directory named like a skipped one must not knock out a real catalogue —
    /// segment matching, not substring matching.
    #[test]
    fn skip_dirs_match_whole_segments_only() {
        assert!(is_candidate_catalog_path("distribution/x.toml"));
        assert!(is_candidate_catalog_path("my-target/x.toml"));
        assert!(is_candidate_catalog_path("builders/x.toml"));
    }

    #[test]
    fn a_missing_directory_is_not_a_usable_clone() {
        assert!(!is_usable(Path::new("/nonexistent/wiretap/clone")));
    }

    /// A libgit2 auth failure has to reach the UI as `Auth`, because that is what
    /// routes the user to Settings → Catalogs rather than offering a pointless retry.
    #[test]
    fn auth_failures_map_to_the_auth_kind() {
        let e = git2::Error::new(
            git2::ErrorCode::Auth,
            git2::ErrorClass::Http,
            "authentication required",
        );
        assert_eq!(map_err(e).kind, ShareErrorKind::Auth);
    }

    #[test]
    fn network_failures_stay_retryable() {
        let e = git2::Error::new(
            git2::ErrorCode::GenericError,
            git2::ErrorClass::Net,
            "failed to resolve host",
        );
        assert_eq!(map_err(e).kind, ShareErrorKind::Network);
    }

    /// The whole read path against a real remote: clone over HTTPS, walk the tree,
    /// read a blob, and confirm the resulting state is what the rest of the module
    /// assumes. This is the Phase 0 build gate kept as a permanent check — it is the
    /// only thing that exercises the platform's TLS backend (SecureTransport on Apple,
    /// WinHTTP on Windows, OpenSSL on Linux), which no amount of unit testing reaches.
    ///
    /// Ignored by default: it hits the network. Run with
    /// `cargo test -p wiretap catalog_share::git -- --ignored`.
    #[test]
    #[ignore = "network"]
    fn clones_lists_and_reads_a_real_repository() {
        // Small, stable, and full of .toml — including a root Cargo.toml the candidate
        // filter must reject, which is the case worth proving against a real tree.
        let spec = RepoSpec {
            repo_id: "gh:rust-lang/log".into(),
            clone_url: "https://github.com/rust-lang/log".into(),
            git_ref: "master".into(),
            token: None,
        };
        let dir = std::env::temp_dir().join("wiretap-git-roundtrip");
        let _ = std::fs::remove_dir_all(&dir);

        let synced = sync_blocking(None, &dir, &spec).expect("clone");
        assert!(synced.cloned, "first sync must clone");
        assert_eq!(synced.head.len(), 40, "head should be a full commit id");
        assert!(is_usable(&dir));

        // A second sync fetches rather than re-cloning, and lands on the same commit.
        let again = sync_blocking(None, &dir, &spec).expect("fetch");
        assert!(!again.cloned, "second sync must reuse the clone");
        assert_eq!(again.head, synced.head);

        // Aligned with origin, so nothing is ahead or behind.
        assert_eq!(ahead_behind_blocking(&dir, "master").expect("counts"), (0, 0));

        let listing = list_blocking(&dir, "master", None).expect("list");
        assert!(
            !listing.blobs.iter().any(|b| b.path.ends_with("Cargo.toml")),
            "build manifests must not be offered as catalogues"
        );

        // The blob SHA libgit2 reports has to equal the one we hash locally — that
        // equality is the entire sync model, so prove it against a real object rather
        // than trusting it.
        let readme = read_blob_blocking(&dir, "master", "README.md").expect("read");
        assert_eq!(
            readme.sha,
            super::super::registry::git_blob_sha(readme.text.as_bytes()),
            "libgit2's blob id must match our git_blob_sha"
        );

        // A tag resolves for reading even though it could never be a push target.
        assert!(read_blob_blocking(&dir, "0.4.22", "README.md").is_ok());
        // And a ref that does not exist fails as NotFound rather than panicking.
        assert_eq!(
            read_blob_blocking(&dir, "no-such-branch", "README.md")
                .unwrap_err()
                .kind,
            ShareErrorKind::NotFound
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Make a bare repository with one commit on `main`, to act as a remote.
    ///
    /// A `file://` remote exercises the real clone, commit and push paths with no
    /// network and no credentials, which is what makes the push tests runnable
    /// everywhere rather than only on a machine with a token.
    #[cfg(test)]
    fn seed_remote(at: &Path) -> String {
        let work = at.join("seed");
        std::fs::create_dir_all(&work).expect("seed dir");
        let repo = Repository::init(&work).expect("init seed");
        // Point HEAD at `main` while it is still unborn, so the first commit creates
        // that branch. Doing it afterwards would leave the commit on whatever
        // `init.defaultBranch` the developer's git config happens to set.
        repo.set_head("refs/heads/main").expect("head main");
        std::fs::write(work.join("catalogs.md"), b"seed\n").expect("seed file");
        let mut index = repo.index().expect("index");
        index.add_path(Path::new("catalogs.md")).expect("add");
        index.write().expect("write index");
        let tree = repo
            .find_tree(index.write_tree().expect("write tree"))
            .expect("tree");
        let sig = Signature::now("Seed", "seed@example.invalid").expect("sig");
        repo.commit(Some("HEAD"), &sig, &sig, "seed", &tree, &[])
            .expect("commit");

        let bare = at.join("remote.git");
        Repository::init_bare(&bare).expect("init bare");
        let mut origin = repo
            .remote("origin", bare.to_str().expect("utf-8 path"))
            .expect("add remote");
        origin
            .push(&["refs/heads/main:refs/heads/main"], None)
            .expect("seed push");
        format!("file://{}", bare.to_string_lossy())
    }

    /// The write path end to end: clone, commit a new file, push, and confirm the
    /// remote actually received it. Push is the one operation where libgit2 can report
    /// success for a rejected update, so "the remote has the commit" is the only
    /// assertion worth making.
    #[test]
    fn commits_and_pushes_to_the_tracked_branch() {
        let root = std::env::temp_dir().join("wiretap-git-push");
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).expect("root");
        let url = seed_remote(&root);

        let spec = RepoSpec {
            repo_id: "gh:test/push".into(),
            clone_url: url.clone(),
            git_ref: "main".into(),
            token: None,
        };
        let dir = root.join("clone");
        sync_blocking(None, &dir, &spec).expect("clone");

        let pushed = push_blocking(
            None,
            &spec.repo_id,
            &dir,
            &PushSpec {
                branch: "main".into(),
                base: "main".into(),
                path: "catalogs/new.toml".into(),
                content: b"[meta]\nname = \"new\"\n".to_vec(),
                message: "add new".into(),
                author_name: "WireTAP".into(),
                author_email: "wiretap@example.invalid".into(),
                push_url: None,
            },
            None,
        )
        .expect("push to the tracked branch");
        assert!(
            !pushed.created_branch,
            "pushing to the tracked branch creates nothing"
        );

        // The remote has it, at the blob sha we recorded.
        let remote = Repository::open_bare(root.join("remote.git")).expect("open bare");
        let tree = remote
            .find_reference("refs/heads/main")
            .and_then(|r| r.peel_to_commit())
            .and_then(|c| c.tree())
            .expect("remote tree");
        let entry = tree
            .get_path(Path::new("catalogs/new.toml"))
            .expect("file landed on the remote");
        assert_eq!(entry.id().to_string(), pushed.blob_sha);

        let _ = std::fs::remove_dir_all(&root);
    }

    /// Naming a branch creates it off the base rather than committing to the base —
    /// the opt-in half of "branches are optional".
    #[test]
    fn a_named_branch_is_created_off_the_base() {
        let root = std::env::temp_dir().join("wiretap-git-branch");
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).expect("root");
        let url = seed_remote(&root);

        let dir = root.join("clone");
        sync_blocking(
            None,
            &dir,
            &RepoSpec {
                repo_id: "gh:test/branch".into(),
                clone_url: url,
                git_ref: "main".into(),
                token: None,
            },
        )
        .expect("clone");

        let pushed = push_blocking(
            None,
            "gh:test/branch",
            &dir,
            &PushSpec {
                branch: "catalog/new".into(),
                base: "main".into(),
                path: "catalogs/new.toml".into(),
                content: b"[meta]\nname = \"new\"\n".to_vec(),
                message: "add new".into(),
                author_name: "WireTAP".into(),
                author_email: "wiretap@example.invalid".into(),
                push_url: None,
            },
            None,
        )
        .expect("push a new branch");
        assert!(pushed.created_branch);

        let remote = Repository::open_bare(root.join("remote.git")).expect("open bare");
        assert!(
            remote.find_reference("refs/heads/catalog/new").is_ok(),
            "the branch must exist on the remote"
        );
        // The base is untouched: the file went to the branch, not to main.
        let main_tree = remote
            .find_reference("refs/heads/main")
            .and_then(|r| r.peel_to_commit())
            .and_then(|c| c.tree())
            .expect("main tree");
        assert!(
            main_tree.get_path(Path::new("catalogs/new.toml")).is_err(),
            "a named branch must not also write to the base"
        );

        let _ = std::fs::remove_dir_all(&root);
    }

    /// A directory that exists but is not a repository must be replaced, not repaired —
    /// this is the self-heal path that covers an interrupted clone and a purged
    /// container, and it is easy to regress into an error.
    #[test]
    #[ignore = "network"]
    fn a_partial_clone_is_replaced() {
        let dir = std::env::temp_dir().join("wiretap-git-partial");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("debris")).expect("make debris");
        std::fs::write(dir.join("debris/half.pack"), b"not a repository").expect("write debris");
        assert!(!is_usable(&dir));

        let synced = sync_blocking(
            None,
            &dir,
            &RepoSpec {
                repo_id: "gh:rust-lang/log".into(),
                clone_url: "https://github.com/rust-lang/log".into(),
                git_ref: "master".into(),
                token: None,
            },
        )
        .expect("re-clone over debris");
        assert!(synced.cloned);
        assert!(is_usable(&dir));
        assert!(!dir.join("debris").exists(), "debris must be cleared");

        let _ = std::fs::remove_dir_all(&dir);
    }
}
