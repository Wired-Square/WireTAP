//! Sharing catalogue decoders over git — import from a URL someone posted, and
//! (from Stage 2) publish yours as a branch plus pull request.
//!
//! Everything runs over the GitHub REST API rather than a git library or the `git`
//! binary: forks and pull requests are GitHub product concepts rather than git
//! operations, so an HTTP client is required either way, and doing the commit over
//! REST too keeps the feature working on iOS with no new heavy dependency.
//!
//! These are Tauri `invoke` commands, not `catalog.*` WebSocket commands. The WS
//! surface is deliberately pure (text in, JSON out, no `AppHandle`), it has a
//! 10-second timeout that a network round trip would blow through, and every
//! existing side-effecting catalogue command is already an `invoke` command.

pub mod auth;
pub mod error;
pub mod git;
pub mod github;
pub mod publish;
pub mod registry;
pub mod secrets;
pub mod url;

use futures::stream::{self, StreamExt};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use error::{ShareError, ShareErrorKind};
use git::TreeBlob;
use github::{GitHubClient, RepoInfo};
use registry::{
    catalog_entry_id, git_blob_sha, CatalogEntry, CatalogSourceRegistry, LocalState, RemoteState,
    RepoEntry, SavedRepo,
};
use url::{parse_catalog_source, CatalogSource};

/// Largest number of frames we will accept in an imported catalogue. Well beyond any
/// real device; an early rejection so an absurd file is refused before it reaches
/// the editor tree. (The line diff bounds itself — see `catalog::MAX_LCS_CELLS`.)
const MAX_FRAMES: usize = 5000;

// ── Browse ───────────────────────────────────────────────────────────────────

/// A candidate catalogue found in a repository, before any content is fetched.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteEntry {
    pub path: String,
    /// Basename, which is what the file would be called locally.
    pub filename: String,
    pub blob_sha: String,
    pub size: u64,
    /// True when a local catalogue already carries this exact provenance — the UI
    /// offers "update" rather than "import" for these.
    pub already_tracked: bool,
    /// True when a local file of the same name exists that we did not import.
    pub name_collides: bool,
}

/// Result of pointing the app at a repository URL.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoBrowse {
    pub source: CatalogSource,
    pub repo: RepoInfo,
    /// The ref actually used, with the repository default resolved.
    pub git_ref: String,
    pub entries: Vec<RemoteEntry>,
    /// Candidates beyond the display cap that were dropped.
    pub dropped: usize,
    pub authenticated: bool,
}

/// Metadata for one remote catalogue, resolved by fetching and parsing it.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteCatalog {
    pub path: String,
    pub blob_sha: String,
    /// `[meta].name`, or `None` when the file could not be parsed.
    pub name: Option<String>,
    pub valid: bool,
    pub errors: Vec<String>,
    pub frame_count: usize,
    /// Frames carrying a transmit interval. Surfaced prominently because an imported
    /// catalogue can define traffic that would be written to a live bus.
    pub transmit_frame_count: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub protocol: Option<wiretap_catalog::Protocol>,
}

/// Parse a shared URL without touching the network, so the paste field can give
/// immediate feedback.
#[tauri::command(rename_all = "camelCase")]
pub fn parse_catalog_source_url(input: String) -> Result<CatalogSource, ShareError> {
    Ok(open_source(&input)?.0)
}

/// List candidate catalogues in a repository.
///
/// One API request for the repository (default branch, visibility, push access), then
/// everything else comes out of the clone. The first browse of a repository clones it,
/// which is slower than the old tree listing and is why this emits progress; every
/// browse after that is a fetch, and the listing itself is free.
#[tauri::command(rename_all = "camelCase")]
pub async fn browse_catalog_repo(
    app: AppHandle,
    input: String,
    git_ref: Option<String>,
    directory: Option<String>,
) -> Result<RepoBrowse, ShareError> {
    let (mut source, client) = open_source(&input)?;
    // Identity always comes from the re-parsed URL; ref and directory are *scope*,
    // and a caller that knows them exactly (a saved repository) says so rather than
    // re-encoding them into a URL for us to parse back out. That also removes the
    // ambiguity a `/tree/<ref>/<path>` round trip would reintroduce.
    source
        .apply_scope(git_ref, directory)
        .map_err(|e| ShareError::invalid(e.message()))?;
    let repo = client.get_repo(&source.owner, &source.repo).await?;

    // Sync against the default branch first: it is always a real branch, so it works
    // whatever the URL claimed, and the clone it produces is what answers the
    // ambiguity question below.
    let synced = synced_clone(&app, &source, &repo.default_branch).await?;

    // A slashed branch name makes `/tree/<ref>/<path>` ambiguous. Resolve it against
    // the refs the clone now holds rather than guessing.
    if source.ref_is_ambiguous {
        resolve_ambiguous_ref(&synced.dir, &mut source, &repo).await;
    }

    let git_ref = source.reference_or(&repo.default_branch).to_string();
    let listing = git::list_catalogues(&synced.dir, &git_ref, source.scope()).await?;

    // One directory scan rather than a stat() per candidate, and the registry lock is
    // held only for the tracked-set lookup.
    let local_names = local_filenames(&app);
    let repo_id = source.repo_id();
    let state = app.state::<CatalogSourceRegistry>();
    let tracked = state.write(&app, |r| {
        r.upsert_repo(repo_entry(&source, &repo));
        let tracked: Vec<String> = listing
            .blobs
            .iter()
            .filter(|b| {
                r.catalog_for_remote(&repo_id, &b.path, &git_ref).is_some()
            })
            .map(|b| b.path.clone())
            .collect();
        tracked
    });

    let entries = listing
        .blobs
        .iter()
        .map(|blob| {
            let filename = basename(&blob.path).to_string();
            let already_tracked = tracked.contains(&blob.path);
            RemoteEntry {
                path: blob.path.clone(),
                already_tracked,
                // A collision only matters when it is not something we imported.
                name_collides: !already_tracked
                    && local_names.iter().any(|n| n.eq_ignore_ascii_case(&filename)),
                filename,
                blob_sha: blob.sha.clone(),
                size: blob.size,
            }
        })
        .collect();

    if listing.dropped > 0 {
        tlog!(
            "[catalog_share] {} listing capped: {} candidates dropped",
            repo.full_name,
            listing.dropped
        );
    }

    Ok(RepoBrowse {
        source,
        git_ref,
        entries,
        dropped: listing.dropped,
        authenticated: client.is_authenticated(),
        repo,
    })
}

/// Fetch and parse specific remote catalogues so the browse list can show real
/// names, validity and transmit-frame counts.
#[tauri::command(rename_all = "camelCase")]
pub async fn resolve_remote_catalogs(
    app: AppHandle,
    input: String,
    git_ref: String,
    paths: Vec<String>,
) -> Result<Vec<RemoteCatalog>, ShareError> {
    let (source, _) = open_source(&input)?;
    let synced = synced_clone(&app, &source, &git_ref).await?;
    let listing = git::list_catalogues(&synced.dir, &git_ref, source.scope()).await?;

    let blobs: Vec<TreeBlob> = paths
        .iter()
        .filter_map(|path| listing.blob(path).cloned())
        .collect();
    let texts = read_catalogues(&synced.dir, &git_ref, &blobs).await;

    Ok(blobs
        .iter()
        .zip(texts)
        .map(|(blob, text)| match text {
            Ok(text) => describe_catalog(&blob.path, &blob.sha, &text),
            Err(e) => RemoteCatalog {
                path: blob.path.clone(),
                blob_sha: blob.sha.clone(),
                name: None,
                valid: false,
                errors: vec![e.message],
                frame_count: 0,
                transmit_frame_count: 0,
                protocol: None,
            },
        })
        .collect())
}

// ── Import ───────────────────────────────────────────────────────────────────

/// What to do when the target filename is already taken.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum CollisionPolicy {
    /// Save alongside as `name-2.toml`. The default: never silently destroy a
    /// hand-written catalogue, which without local git history is unrecoverable.
    #[default]
    KeepBoth,
    Skip,
    Overwrite,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportRequest {
    /// The URL as pasted; re-parsed here so the frontend cannot smuggle in a
    /// different repository than the one it browsed.
    pub input: String,
    pub git_ref: String,
    pub paths: Vec<String>,
    #[serde(default)]
    pub on_collision: CollisionPolicy,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ImportOutcome {
    Imported,
    Updated,
    Skipped,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportResult {
    pub path: String,
    pub outcome: ImportOutcome,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub filename: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

impl ImportResult {
    fn refused(
        path: &str,
        outcome: ImportOutcome,
        name: Option<String>,
        message: impl Into<String>,
    ) -> Self {
        Self {
            path: path.to_string(),
            outcome,
            filename: None,
            name,
            message: Some(message.into()),
        }
    }

    fn written(path: &str, outcome: ImportOutcome, filename: String, name: Option<String>) -> Self {
        Self {
            path: path.to_string(),
            outcome,
            filename: Some(filename),
            name,
            message: None,
        }
    }
}

/// Fetch the selected catalogues and write them into the decoder directory.
///
/// Validates every file before writing, writes via a temp file plus rename so
/// neither the directory watcher nor a concurrent scan can observe a half-written
/// TOML, and refreshes the catalogue cache exactly once at the end.
#[tauri::command(rename_all = "camelCase")]
pub async fn import_remote_catalogs(
    app: AppHandle,
    req: ImportRequest,
) -> Result<Vec<ImportResult>, ShareError> {
    let (source, _) = open_source(&req.input)?;
    if req.paths.is_empty() {
        return Ok(Vec::new());
    }

    let decoder_dir = crate::catalog::decoder_dir(&app).ok_or_else(|| {
        ShareError::invalid("The decoder directory is not available — check Settings → Locations")
    })?;
    std::fs::create_dir_all(&decoder_dir)
        .map_err(|e| ShareError::invalid(format!("Could not create the decoder directory: {e}")))?;

    let synced = synced_clone(&app, &source, &req.git_ref).await?;
    let listing = git::list_catalogues(&synced.dir, &req.git_ref, source.scope()).await?;
    let repo_id = source.repo_id();

    // Phase 1: collect the blobs asked for, noting any that have since disappeared.
    let (blobs, mut results): (Vec<TreeBlob>, Vec<ImportResult>) = {
        let mut blobs = Vec::new();
        let mut missing = Vec::new();
        for path in &req.paths {
            match listing.blob(path) {
                Some(blob) => blobs.push(blob.clone()),
                None => missing.push(ImportResult::refused(
                    path,
                    ImportOutcome::Failed,
                    None,
                    format!("{path} is no longer in the repository"),
                )),
            }
        }
        (blobs, missing)
    };
    let texts = read_catalogues(&synced.dir, &req.git_ref, &blobs).await;

    // Phase 2: validate and write sequentially, collecting registry updates so the
    // whole batch costs one registry write rather than one per file.
    let tracked_filenames = app.state::<CatalogSourceRegistry>().read(&app, |r| {
        blobs
            .iter()
            .map(|blob| {
                r.catalog_for_remote(&repo_id, &blob.path, &req.git_ref)
                    .map(|c| c.local_filename.clone())
            })
            .collect::<Vec<_>>()
    });

    let mut new_entries = Vec::new();
    for ((blob, text), existing) in blobs.iter().zip(texts).zip(tracked_filenames) {
        let text = match text {
            Ok(text) => text,
            Err(e) => {
                results.push(ImportResult::refused(
                    &blob.path,
                    ImportOutcome::Failed,
                    None,
                    e.message,
                ));
                continue;
            }
        };

        match write_import(&decoder_dir, blob, &text, existing, req.on_collision) {
            Ok((filename, outcome, name)) => {
                new_entries.push(CatalogEntry {
                    id: catalog_entry_id(&repo_id, &blob.path, &req.git_ref),
                    repo_id: repo_id.clone(),
                    remote_path: blob.path.clone(),
                    git_ref: req.git_ref.clone(),
                    synced_sha: git_blob_sha(text.as_bytes()),
                    local_filename: filename.clone(),
                    imported_at: chrono::Utc::now().to_rfc3339(),
                    remote_sha: Some(blob.sha.clone()),
                    publish: None,
                });
                results.push(ImportResult::written(&blob.path, outcome, filename, name));
            }
            Err(result) => results.push(result),
        }
    }

    if !new_entries.is_empty() {
        app.state::<CatalogSourceRegistry>().write(&app, |r| {
            for entry in new_entries {
                r.upsert_catalog(entry);
            }
        });
        // One refresh for the whole batch. On iOS this is not an optimisation — there
        // is no filesystem watcher there, so it is the only thing that updates the
        // catalogue list.
        crate::catalog::refresh_catalog_cache(&app);
    }

    Ok(results)
}

/// Validate one fetched catalogue and write it, returning the filename used.
///
/// `Err` carries the user-facing refusal rather than a failure — a rejected file is
/// a normal outcome of importing from a stranger's repository.
type WriteOutcome = (String, ImportOutcome, Option<String>);
/// Reject a catalogue that must not reach the decoder directory.
///
/// Validity is a schema check, not a security boundary — it is what stops a stray
/// `Cargo.toml`. The frame cap is an early rejection so an absurd file is refused
/// before it reaches the editor tree.
fn vet_catalogue(text: &str) -> Result<RemoteCatalog, String> {
    let described = describe_catalog("", "", text);
    if !described.valid {
        return Err(format!("not a valid catalogue: {}", described.errors.join("; ")));
    }
    if described.frame_count > MAX_FRAMES {
        return Err(format!(
            "declares {} frames, beyond the {MAX_FRAMES} supported",
            described.frame_count
        ));
    }
    Ok(described)
}

fn write_import(
    decoder_dir: &std::path::Path,
    blob: &TreeBlob,
    text: &str,
    existing: Option<String>,
    on_collision: CollisionPolicy,
) -> Result<WriteOutcome, ImportResult> {
    let described = vet_catalogue(text).map_err(|why| {
        ImportResult::refused(
            &blob.path,
            ImportOutcome::Failed,
            None,
            format!("Not imported — {why}"),
        )
    })?;

    let desired = crate::catalog::sanitise_catalog_filename(basename(&blob.path))
        .map_err(|e| ImportResult::refused(&blob.path, ImportOutcome::Failed, None, e))?;
    let taken = decoder_dir.join(&desired).exists();

    // A file we previously imported from this exact source is an update, not a
    // collision — reuse its filename whatever the policy says.
    let (filename, outcome) = match (existing, taken, on_collision) {
        (Some(filename), _, _) => (filename, ImportOutcome::Updated),
        (None, false, _) => (desired, ImportOutcome::Imported),
        (None, true, CollisionPolicy::Overwrite) => (desired, ImportOutcome::Imported),
        (None, true, CollisionPolicy::KeepBoth) => (
            crate::catalog::next_free_catalog_filename(decoder_dir, &desired),
            ImportOutcome::Imported,
        ),
        (None, true, CollisionPolicy::Skip) => {
            return Err(ImportResult::refused(
                &blob.path,
                ImportOutcome::Skipped,
                described.name,
                "A catalogue of that name already exists",
            ))
        }
    };

    // Byte-exact write. The provenance hash is a git blob SHA over these exact bytes,
    // so normalising line endings here would break change detection (and would be a
    // real diff upstream anyway).
    crate::catalog::write_file_atomically(&decoder_dir.join(&filename), text.as_bytes())
        .map_err(|e| ImportResult::refused(&blob.path, ImportOutcome::Failed, None, e))?;

    Ok((filename, outcome, described.name))
}

// ── Tracked sources ──────────────────────────────────────────────────────────

/// A local catalogue's provenance and sync state, for the settings list.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackedCatalog {
    pub id: String,
    pub local_filename: String,
    pub repo_id: String,
    pub repo_label: String,
    pub remote_path: String,
    pub git_ref: String,
    pub local_state: LocalState,
    pub remote_state: RemoteState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub web_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pr_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pr_number: Option<u64>,
    pub pr_merged: bool,
}

/// Current state of a tracked catalogue's pull request.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackedPr {
    pub number: u64,
    pub url: String,
    pub merged: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogSourcesView {
    pub catalogs: Vec<TrackedCatalog>,
    pub saved_repos: Vec<SavedRepoView>,
    pub favourite_repo_id: Option<String>,
    /// Whether a token is stored. The token itself never leaves Rust.
    pub has_token: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub login: Option<String>,
}

/// Provenance and sync state for every tracked catalogue.
///
/// Reconciles against the decoder directory first, so renames done outside the app
/// are followed by content hash rather than reported as broken.
#[tauri::command(rename_all = "camelCase")]
pub async fn list_catalog_sources(app: AppHandle) -> Result<CatalogSourcesView, ShareError> {
    let decoder_dir = crate::catalog::decoder_dir(&app);
    let has_token = auth::stored_token(github::SUPPORTED_HOST).is_some();
    let state = app.state::<CatalogSourceRegistry>();

    if let Some(dir) = decoder_dir.as_deref() {
        // write_if: reconcile usually changes nothing, and rewriting the registry on
        // every listing would be pure churn.
        state.write_if(&app, |r| r.reconcile(dir));
    }

    Ok(state.read(&app, |r| CatalogSourcesView {
        catalogs: project_tracked(r, decoder_dir.as_deref()),
        saved_repos: saved_repo_views(&app, r),
        favourite_repo_id: r.favourite_repo_id.clone(),
        has_token,
        login: r.identity.as_ref().map(|i| i.login.clone()),
    }))
}

/// The tracked-catalogue projection. Shared by the listing and the update check so
/// there is one definition of what the UI sees.
fn project_tracked(
    r: &registry::Registry,
    decoder_dir: Option<&std::path::Path>,
) -> Vec<TrackedCatalog> {
    r.catalogs
        .iter()
        .map(|entry| {
            let repo = r.repo(&entry.repo_id);
            let local_state = decoder_dir
                .map(|dir| entry.local_state(dir))
                .unwrap_or(LocalState::Missing);
            TrackedCatalog {
                id: entry.id.clone(),
                local_filename: entry.local_filename.clone(),
                repo_id: entry.repo_id.clone(),
                repo_label: repo
                    .map(|r| format!("{}/{}", r.owner, r.repo))
                    .unwrap_or_else(|| strip_host_prefix(&entry.repo_id).to_string()),
                remote_path: entry.remote_path.clone(),
                git_ref: entry.git_ref.clone(),
                local_state,
                remote_state: entry.remote_state(local_state, decoder_dir),
                web_url: repo.and_then(|r| r.web_url.clone()),
                pr_url: entry.publish.as_ref().and_then(|p| p.pr_url.clone()),
                pr_number: entry.publish.as_ref().and_then(|p| p.pr_number),
                pr_merged: entry.publish.as_ref().is_some_and(|p| p.merged),
            }
        })
        .collect()
}

/// Outcome of checking tracked repositories for upstream changes.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCheckResult {
    /// The refreshed projection, so the caller needs no follow-up listing.
    pub catalogs: Vec<TrackedCatalog>,
    pub repos_checked: usize,
    pub updates_available: usize,
    /// Repositories that could not be reached, with why.
    pub failures: Vec<UpdateCheckFailure>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCheckFailure {
    pub repo_label: String,
    /// The typed error, so a rate-limited or auth-failed batch check gets the same
    /// actionable hint a single-repository browse does.
    #[serde(flatten)]
    pub error: ShareError,
}

/// One repository+ref to check, with the catalogues tracked against it.
///
/// A repository tracked at two refs is two targets: the head commit differs per ref,
/// so a shared record would flip-flop and the short-circuit would never fire.
struct CheckTarget {
    repo_id: String,
    owner: String,
    repo: String,
    git_ref: String,
    /// Built once when the target is, so the keychain is not read again inside the
    /// concurrent check loop.
    spec: git::RepoSpec,
    /// Head commit at the last check, for the short-circuit.
    last_head: Option<String>,
    /// `(catalog id, remote path)` for every catalogue tracked at this repo+ref.
    catalogs: Vec<(String, String)>,
}

impl CheckTarget {
    fn label(&self) -> String {
        format!("{}/{}", self.owner, self.repo)
    }
}

/// What one target's network pass found, applied to the registry afterwards.
struct CheckOutcome {
    repo_id: String,
    git_ref: String,
    head: String,
    /// `(catalog id, blob sha)` for catalogues still present upstream.
    shas: Vec<(String, String)>,
}

/// The remote text for one tracked catalogue, alongside the local copy.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteCatalogText {
    pub catalog_id: String,
    pub local_filename: String,
    pub repo_label: String,
    /// Upstream content.
    pub remote_toml: String,
    pub remote_blob_sha: String,
    /// The local file as it is on disk right now.
    pub local_toml: String,
    /// Git blob SHA-1 of the local file, echoed back on apply so the backend can
    /// refuse to overwrite a file that changed while it was being reviewed.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub local_sha: Option<String>,
    pub local_state: LocalState,
    /// Empty when the upstream file is a valid catalogue; applying is blocked otherwise.
    pub validation_errors: Vec<String>,
    /// Transmit-interval frames the update would introduce, for the same reason
    /// import surfaces them: a catalogue can define traffic that reaches a live bus.
    pub transmit_frame_count: usize,
}

/// Check tracked repositories for upstream changes.
///
/// Batched per repository+ref and short-circuited on the head commit: an unchanged
/// repository skips its tree listing entirely, which is a large bandwidth saving (a
/// recursive tree on a big repository is orders of magnitude bigger than a
/// single-commit response) even though the request count is the same. `repo_id`
/// limits the check to one repository; `None` checks all of them.
///
/// Networking happens in the loop; every registry change is applied in **one** write
/// afterwards, matching `import_remote_catalogs`.
#[tauri::command(rename_all = "camelCase")]
pub async fn check_catalog_updates(
    app: AppHandle,
    // Always `None` today — the seam for a per-repository refresh, so untested until
    // something calls it with a value.
    repo_id: Option<String>,
) -> Result<UpdateCheckResult, ShareError> {
    let decoder_dir = crate::catalog::decoder_dir(&app);
    let state = app.state::<CatalogSourceRegistry>();

    // One read builds every target, including each one's catalogue list, so the loop
    // needs no further registry access.
    let targets = state.read(&app, |r| {
        let mut targets: Vec<CheckTarget> = Vec::new();
        for entry in &r.catalogs {
            if repo_id.as_deref().is_some_and(|id| id != entry.repo_id) {
                continue;
            }
            let Some(repo) = r.repo(&entry.repo_id) else {
                continue;
            };
            let item = (entry.id.clone(), entry.remote_path.clone());
            match targets
                .iter_mut()
                .find(|t| t.repo_id == entry.repo_id && t.git_ref == entry.git_ref)
            {
                Some(target) => target.catalogs.push(item),
                None => targets.push(CheckTarget {
                    repo_id: entry.repo_id.clone(),
                    owner: repo.owner.clone(),
                    repo: repo.repo.clone(),
                    spec: git::RepoSpec::for_repo(repo, &entry.git_ref),
                    git_ref: entry.git_ref.clone(),
                    last_head: repo.head_for_ref(&entry.git_ref),
                    catalogs: vec![item],
                }),
            }
        }
        targets
    });

    let client = GitHubClient::new(auth::stored_token(github::SUPPORTED_HOST));
    let repos_checked = targets
        .iter()
        .map(|t| t.repo_id.as_str())
        .collect::<std::collections::HashSet<_>>()
        .len();

    // Fetch each *repository* once, then check its refs against that one fetch.
    //
    // Targets are keyed by repository **and** ref, so a repository tracked at two refs
    // is two targets sharing one clone directory. Running those concurrently would
    // fetch the same remote twice for nothing, and have two libgit2 handles writing
    // the same repository at once. Grouping first removes both.
    let mut groups: Vec<Vec<usize>> = Vec::new();
    for (i, target) in targets.iter().enumerate() {
        match groups
            .iter_mut()
            .find(|g| targets[g[0]].repo_id == target.repo_id)
        {
            Some(group) => group.push(i),
            None => groups.push(vec![i]),
        }
    }

    let targets = std::sync::Arc::new(targets);
    let grouped: Vec<Vec<(usize, Result<Option<CheckOutcome>, ShareError>)>> =
        stream::iter(groups.into_iter())
            .map(|indices| {
                let (app, targets) = (app.clone(), targets.clone());
                async move {
                    let mut results = Vec::with_capacity(indices.len());
                    for i in indices {
                        results.push((i, check_one(&app, &targets[i]).await));
                    }
                    results
                }
            })
            .buffered(github::GIT_CONCURRENCY)
            .collect()
            .await;

    // Back into target order, so the zip below still lines up.
    let mut checked: Vec<Option<Result<Option<CheckOutcome>, ShareError>>> =
        targets.iter().map(|_| None).collect();
    for (i, result) in grouped.into_iter().flatten() {
        checked[i] = Some(result);
    }
    let checked: Vec<Result<Option<CheckOutcome>, ShareError>> =
        checked.into_iter().flatten().collect();

    let mut outcomes = Vec::new();
    let mut failures = Vec::new();
    for (target, result) in targets.iter().zip(checked) {
        match result {
            Ok(Some(outcome)) => outcomes.push(outcome),
            Ok(None) => {}
            Err(e) => failures.push(UpdateCheckFailure {
                repo_label: target.label(),
                error: e,
            }),
        }
    }

    // Refresh open pull requests in the same pass — a merge is what the user is
    // waiting to see, and adding a separate button for it would be worse.
    let open_prs = state.read(&app, |r| r.open_pulls(repo_id.as_deref(), None));
    let polled: Vec<Result<github::PullRequest, ShareError>> = stream::iter(0..open_prs.len())
        .map(|i| {
            let (client, pr) = (&client, &open_prs[i]);
            async move { client.get_pull(&pr.owner, &pr.repo, pr.number).await }
        })
        .buffered(github::FETCH_CONCURRENCY)
        .collect()
        .await;

    let mut pulls = Vec::new();
    for (pr, result) in open_prs.iter().zip(polled) {
        match result {
            Ok(pull) => pulls.push((pr.catalog_id.clone(), pull)),
            Err(e) => failures.push(UpdateCheckFailure {
                repo_label: format!("{}/{}#{}", pr.owner, pr.repo, pr.number),
                error: e,
            }),
        }
    }

    // Everything the check learned, in one write.
    state.write_if(&app, |r| {
        let mut changed = false;
        for outcome in &outcomes {
            for (id, sha) in &outcome.shas {
                changed |= r.set_remote_sha(id, sha);
            }
            changed |= r.set_head_for_ref(&outcome.repo_id, &outcome.git_ref, &outcome.head);
        }
        for (catalog_id, pull) in &pulls {
            changed |= record_pull(r, catalog_id, pull);
        }
        changed
    });

    let catalogs = state.read(&app, |r| project_tracked(r, decoder_dir.as_deref()));
    let updates_available = catalogs
        .iter()
        .filter(|c| {
            matches!(
                c.remote_state,
                RemoteState::UpstreamAhead | RemoteState::Diverged
            )
        })
        .count();

    Ok(UpdateCheckResult {
        catalogs,
        repos_checked,
        updates_available,
        failures,
    })
}

/// Fetch, then walk the tree only if the head moved.
///
/// `Ok(None)` means there is nothing to do: the head is where the last check left it.
/// The fetch itself is the cost — walking the tree afterwards is local and free, so
/// the short-circuit now saves work rather than bandwidth.
async fn check_one(app: &AppHandle, target: &CheckTarget) -> Result<Option<CheckOutcome>, ShareError> {
    let synced = git::sync(app, &target.spec).await?;
    if target.last_head.as_deref() == Some(synced.head.as_str()) {
        return Ok(None);
    }

    // Read at the ref, which the fetch above just moved to `synced.head` — so the shas
    // necessarily belong to the head recorded beside them. The old REST path had to
    // pin the listing to the commit and bypass a cache to get that guarantee; with a
    // clone it falls out of having fetched.
    let listing = git::list_catalogues(&synced.dir, &target.git_ref, None).await?;
    let head = synced.head;

    Ok(Some(CheckOutcome {
        repo_id: target.repo_id.clone(),
        git_ref: target.git_ref.clone(),
        head,
        // A file deleted upstream keeps its last known sha rather than reporting a
        // spurious update.
        shas: target
            .catalogs
            .iter()
            .filter_map(|(id, path)| listing.blob(path).map(|b| (id.clone(), b.sha.clone())))
            .collect(),
    }))
}

/// Apply a pull's current state to a tracked catalogue, reporting whether anything
/// moved. Shared by the batch check and the single-catalogue refresh so the two
/// cannot record different things.
fn record_pull(
    r: &mut registry::Registry,
    catalog_id: &str,
    pull: &github::PullRequest,
) -> bool {
    let Some(publish) = r
        .catalog_by_id_mut(catalog_id)
        .and_then(|e| e.publish.as_mut())
    else {
        return false;
    };
    let changed = publish.merged != pull.merged
        || publish.pr_url.as_deref() != Some(pull.html_url.as_str());
    publish.merged = pull.merged;
    publish.pr_url = Some(pull.html_url.clone());
    changed
}

/// Fetch the upstream copy of a tracked catalogue, for review against the local one.
#[tauri::command(rename_all = "camelCase")]
pub async fn fetch_remote_catalog(
    app: AppHandle,
    catalog_id: String,
) -> Result<RemoteCatalogText, ShareError> {
    let decoder_dir = crate::catalog::decoder_dir(&app)
        .ok_or_else(|| ShareError::invalid("The decoder directory is not available"))?;
    let snap = snapshot_tracked(&app, &catalog_id, &decoder_dir)?;

    // Fetch first, so the bytes reviewed are current rather than whatever the last
    // check happened to record. The old REST path had to fall back to a tree listing
    // when no check had run; with a clone there is only one path.
    let synced = git::sync(&app, &snap.spec).await?;
    let remote = git::read_blob(&synced.dir, &snap.git_ref, &snap.remote_path)
        .await
        .map_err(|e| match e.kind {
            ShareErrorKind::NotFound => ShareError::not_found(format!(
                "{} is no longer in {}",
                snap.remote_path, snap.label
            )),
            _ => e,
        })?;
    let (remote_toml, blob_sha) = (remote.text, remote.sha);

    let described = describe_catalog(&snap.remote_path, &blob_sha, &remote_toml);
    let local_path = decoder_dir.join(&snap.filename);

    Ok(RemoteCatalogText {
        catalog_id,
        local_filename: snap.filename,
        repo_label: snap.label,
        remote_toml,
        remote_blob_sha: blob_sha,
        local_sha: registry::git_blob_sha_of_file(&local_path),
        local_toml: std::fs::read_to_string(&local_path).unwrap_or_default(),
        local_state: snap.local_state,
        validation_errors: described.errors,
        transmit_frame_count: described.transmit_frame_count,
    })
}

/// Overwrite the local catalogue with the upstream copy.
///
/// Refuses when the local file has its own edits, or when it changed since it was
/// reviewed. The dialog also hides the action in the first case, but the invariant
/// "an update never destroys local work" belongs here — the UI cannot see a file
/// edited between opening the review and pressing Apply.
#[tauri::command(rename_all = "camelCase")]
pub async fn apply_catalog_update(
    app: AppHandle,
    catalog_id: String,
    toml: String,
    // Blob SHA of the local file as reviewed, from `fetch_remote_catalog`.
    expected_local_sha: Option<String>,
) -> Result<(), ShareError> {
    // Same gate as every other path that writes into the decoder directory: the
    // frontend supplied these bytes, and this is the path that feeds the editor tree.
    vet_catalogue(&toml).map_err(|why| {
        ShareError::invalid(format!("The upstream catalogue was not applied: {why}"))
    })?;

    let decoder_dir = crate::catalog::decoder_dir(&app)
        .ok_or_else(|| ShareError::invalid("The decoder directory is not available"))?;
    let state = app.state::<CatalogSourceRegistry>();
    let Some((filename, local_state)) = state.read(&app, |r| {
        r.catalog_by_id(&catalog_id)
            .map(|e| (e.local_filename.clone(), e.local_state(&decoder_dir)))
    }) else {
        return Err(ShareError::not_found(
            "That catalogue is no longer being tracked",
        ));
    };

    let target = decoder_dir.join(
        crate::catalog::sanitise_catalog_filename(&filename).map_err(ShareError::invalid)?,
    );
    // Unconditional: `None` legitimately means "there was no local file when I
    // reviewed", so it must still be compared rather than waved through.
    if registry::git_blob_sha_of_file(&target) != expected_local_sha {
        return Err(ShareError::invalid(
            "The local file changed while you were reviewing the update, so it was \
             not overwritten. Check for updates again.",
        ));
    }

    install_update(&app, &decoder_dir, &catalog_id, &filename, &toml, local_state)
}

/// Back up the local catalogue and replace it with `toml`.
///
/// The one place an upstream copy reaches the decoder directory, shared by the
/// reviewed apply and the one-click pull so the "never destroy local work" rule
/// cannot hold in one path and not the other. Callers vet the TOML first; this owns
/// the local-changes refusal, the backup, the atomic write and the sync bookkeeping.
fn install_update(
    app: &AppHandle,
    decoder_dir: &std::path::Path,
    catalog_id: &str,
    filename: &str,
    toml: &str,
    local_state: LocalState,
) -> Result<(), ShareError> {
    if local_state == LocalState::Modified {
        return Err(ShareError::invalid(
            "This catalogue has local changes, so it was not overwritten. \
             Open it in the Catalog editor to review the update against your copy.",
        ));
    }

    let target = decoder_dir.join(
        crate::catalog::sanitise_catalog_filename(filename).map_err(ShareError::invalid)?,
    );
    // Derived rather than taken from the caller, so the stored hash is always the
    // hash of the bytes actually written.
    let blob_sha = registry::git_blob_sha(toml.as_bytes());
    back_up_catalogue(decoder_dir, filename, &target);
    crate::catalog::write_file_atomically(&target, toml.as_bytes())
        .map_err(ShareError::invalid)?;

    app.state::<CatalogSourceRegistry>().write(app, |r| {
        r.update_catalog_by_id(catalog_id, |entry| entry.mark_exchanged(blob_sha));
    });
    crate::catalog::refresh_catalog_cache(app);
    Ok(())
}

/// What a pull did.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum PullOutcome {
    /// Upstream holds the bytes we last exchanged; nothing to take.
    UpToDate,
    /// The local copy was replaced, because it had no edits of its own to lose.
    Applied { filename: String },
    /// Both sides moved. Nothing was written — the caller opens the diff review.
    NeedsReview,
    /// The file is no longer in the repository. Reported rather than treated as an
    /// error, so the UI can offer to stop tracking it.
    GoneUpstream,
}

/// Pull one catalogue: fetch its repository, and take the update when it is safe to.
///
/// The whole point of the one-click path is that the common case — a clean copy and a
/// moved upstream — needs no decision from the user, and the diff review appears only
/// when there genuinely is one to make.
#[tauri::command(rename_all = "camelCase")]
pub async fn pull_catalog(app: AppHandle, catalog_id: String) -> Result<PullOutcome, ShareError> {
    let decoder_dir = crate::catalog::decoder_dir(&app)
        .ok_or_else(|| ShareError::invalid("The decoder directory is not available"))?;
    let state = app.state::<CatalogSourceRegistry>();

    let snap = snapshot_tracked(&app, &catalog_id, &decoder_dir)?;

    let synced = git::sync(&app, &snap.spec).await?;
    let remote = match git::read_blob(&synced.dir, &snap.git_ref, &snap.remote_path).await {
        Ok(remote) => remote,
        Err(e) if e.kind == ShareErrorKind::NotFound => return Ok(PullOutcome::GoneUpstream),
        Err(e) => return Err(e),
    };

    // Record what upstream holds whatever happens next, so the badge is right even
    // when the pull itself declines to write.
    state.write_if(&app, |r| r.set_remote_sha(&catalog_id, &remote.sha));

    if remote.sha == snap.synced_sha {
        return Ok(PullOutcome::UpToDate);
    }
    if snap.local_state == LocalState::Modified {
        return Ok(PullOutcome::NeedsReview);
    }

    vet_catalogue(&remote.text)
        .map_err(|why| ShareError::invalid(format!("The upstream catalogue was not applied: {why}")))?;
    install_update(
        &app,
        &decoder_dir,
        &catalog_id,
        &snap.filename,
        &remote.text,
        snap.local_state,
    )?;
    Ok(PullOutcome::Applied {
        filename: snap.filename,
    })
}

/// Where a repository's clone is, and how far it has drifted from `origin`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoStatus {
    pub repo_id: String,
    /// Absolute path to the clone. Derived per call — never stored — so it survives an
    /// iOS container UUID change.
    pub clone_path: String,
    /// False when nothing has been cloned yet, so the UI can say "not fetched" rather
    /// than showing a path that is not there.
    pub cloned: bool,
    pub branch: String,
    pub ahead: usize,
    pub behind: usize,
}

/// Local status of a repository's clone. No network — this reads what is on disk.
#[tauri::command(rename_all = "camelCase")]
pub async fn repo_status(app: AppHandle, repo_id: String) -> Result<RepoStatus, ShareError> {
    let state = app.state::<CatalogSourceRegistry>();
    // The tracked ref, falling back to the repository default: a repository whose
    // catalogues all came from one branch should report that branch, not `main`.
    let branch = state
        .read(&app, |r| {
            r.catalogs
                .iter()
                .find(|c| c.repo_id == repo_id)
                .map(|c| c.git_ref.clone())
                .or_else(|| r.repo(&repo_id).map(|e| e.default_branch.clone()))
        })
        .ok_or_else(|| ShareError::not_found("That repository is not being tracked"))?;

    let dir = git::clone_dir(&app, &repo_id)?;
    let cloned = git::is_usable(&dir);
    // A clone that exists but has no local branch yet (tag-tracked, or interrupted)
    // is reported as in sync rather than failing the whole status call.
    let (ahead, behind) = if cloned {
        git::ahead_behind(&dir, &branch).await.unwrap_or((0, 0))
    } else {
        (0, 0)
    };

    Ok(RepoStatus {
        repo_id,
        clone_path: dir.to_string_lossy().to_string(),
        cloned,
        branch,
        ahead,
        behind,
    })
}

/// Copy the current file aside before overwriting it.
///
/// Best-effort: a failed backup must not block an update the user asked for. The
/// directory is dotted so it stays out of the way in Finder, and it is a
/// subdirectory so the non-recursive catalogue scanner never sees it.
fn back_up_catalogue(decoder_dir: &std::path::Path, filename: &str, source: &std::path::Path) {
    if !source.exists() {
        return;
    }
    let dir = decoder_dir.join(".wiretap-backups");
    if std::fs::create_dir_all(&dir).is_err() {
        return;
    }
    let stamp = chrono::Utc::now().format("%Y%m%dT%H%M%SZ");
    let stem = filename.strip_suffix(".toml").unwrap_or(filename);
    if let Err(e) = std::fs::copy(source, dir.join(format!("{stem}.{stamp}.toml"))) {
        tlog!("[catalog_share] could not back up {} before update: {}", filename, e);
    }
}

/// Current state of a tracked catalogue's pull request — open, or merged.
///
/// Lives here with `list_catalog_sources` rather than in `publish.rs`: it is a
/// read-only query over the same tracked-catalogue projection, not part of the
/// publish machinery.
#[tauri::command(rename_all = "camelCase")]
pub async fn refresh_pr_status(
    app: AppHandle,
    catalog_id: String,
) -> Result<Option<TrackedPr>, ShareError> {
    // One lock, one snapshot: the entry and its repository must agree.
    let Some((owner, repo, number)) = app.state::<CatalogSourceRegistry>().read(&app, |r| {
        let entry = r.catalog_by_id(&catalog_id)?;
        let number = entry.publish.as_ref()?.pr_number?;
        let repo = r.repo(&entry.repo_id)?;
        Some((repo.owner.clone(), repo.repo.clone(), number))
    }) else {
        return Ok(None);
    };

    let client = GitHubClient::new(auth::stored_token(github::SUPPORTED_HOST));
    let pull = client.get_pull(&owner, &repo, number).await?;

    // write_if: the answer is usually unchanged, and rewriting the whole registry to
    // record nothing is pure churn.
    app.state::<CatalogSourceRegistry>()
        .write_if(&app, |r| record_pull(r, &catalog_id, &pull));

    Ok(Some(TrackedPr {
        number: pull.number,
        url: pull.html_url,
        merged: pull.merged,
    }))
}

/// Stop tracking a catalogue. Leaves the file alone — this forgets provenance, it
/// does not delete anything.
#[tauri::command(rename_all = "camelCase")]
pub fn forget_catalog_source(app: AppHandle, catalog_id: String) -> Result<(), ShareError> {
    let removed = app
        .state::<CatalogSourceRegistry>()
        .write_if(&app, |r| r.forget_id(&catalog_id));
    if !removed {
        return Err(ShareError::not_found(
            "That catalogue is no longer being tracked",
        ));
    }
    Ok(())
}

// ── Saved repositories ───────────────────────────────────────────────────────

/// The saved list after a mutation, so callers patch state instead of re-listing.
///
/// Returned rather than left to a follow-up `list_catalog_sources`, which
/// reconciles the decoder directory and hashes every tracked catalogue on disk —
/// far too much work to answer "which repositories are saved?".
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedReposView {
    pub saved_repos: Vec<SavedRepoView>,
    pub favourite_repo_id: Option<String>,
}

/// A saved repository plus where its clone is, so the list answers "is this one
/// fetched, and where does it live?" without a call per row.
///
/// Derived here rather than stored on [`SavedRepo`]: the clone path must never be
/// persisted (see `git::repos_root`), and a saved repository has no clone at all
/// until it is first browsed.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedRepoView {
    #[serde(flatten)]
    pub repo: SavedRepo,
    pub clone_path: String,
    pub cloned: bool,
}

/// The saved list with each entry's clone location attached.
fn saved_repo_views(app: &AppHandle, r: &registry::Registry) -> Vec<SavedRepoView> {
    r.saved_repos
        .iter()
        .map(|repo| {
            let dir = git::clone_dir(app, &repo.id).ok();
            SavedRepoView {
                cloned: dir.as_deref().is_some_and(git::is_usable),
                clone_path: dir.map(|d| d.to_string_lossy().to_string()).unwrap_or_default(),
                repo: repo.clone(),
            }
        })
        .collect()
}

impl SavedReposView {
    fn of(app: &AppHandle, r: &registry::Registry) -> Self {
        Self {
            saved_repos: saved_repo_views(app, r),
            favourite_repo_id: r.favourite_repo_id.clone(),
        }
    }
}

/// A saved repository plus the refreshed list it now belongs to.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveRepoResult {
    pub saved: SavedRepo,
    #[serde(flatten)]
    pub repos: SavedReposView,
}

/// Save a repository so it can be browsed and published to without retyping a URL.
///
/// The input goes through the same parser as every other command, so it accepts
/// any form the picker does and inherits the host and traversal guards. Where the
/// caller leaves them unset, the ref and directory are taken from the URL itself:
/// pasting `…/tree/main/catalogs` saves the repository, the ref `main` and the
/// directory `catalogs` in one step.
#[tauri::command(rename_all = "camelCase")]
pub fn save_catalog_repo(
    app: AppHandle,
    input: String,
    label: Option<String>,
    git_ref: Option<String>,
    directory: Option<String>,
) -> Result<SaveRepoResult, ShareError> {
    let (source, _) = open_source(&input)?;
    let entry = saved_repo_from(&source, label, git_ref, directory)?;
    let saved = entry.clone();
    let repos = app
        .state::<CatalogSourceRegistry>()
        .write_checked(&app, |r| {
            r.save_repo(entry);
            (SavedReposView::of(&app, r), true)
        })
        .map_err(ShareError::invalid)?;
    Ok(SaveRepoResult { saved, repos })
}

/// Build the entry, filling anything the caller left blank from the parsed URL.
///
/// A directory typed into the edit dialog never reached the URL parser, so it is
/// validated here — `apply_scope` owns that rule.
fn saved_repo_from(
    source: &CatalogSource,
    label: Option<String>,
    git_ref: Option<String>,
    directory: Option<String>,
) -> Result<SavedRepo, ShareError> {
    let mut scoped = source.clone();
    scoped
        .apply_scope(git_ref, directory)
        .map_err(|e| ShareError::invalid(e.message()))?;

    Ok(SavedRepo {
        id: scoped.repo_id(),
        url: scoped.repo_url(),
        owner: scoped.owner.clone(),
        repo: scoped.repo.clone(),
        label: label
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty()),
        git_ref: scoped.reference.clone(),
        // A file URL names the catalogue, not a directory to import from.
        directory: match scoped.kind {
            url::SourceKind::Directory => scoped.path.clone(),
            _ => None,
        },
        saved_at: chrono::Utc::now().to_rfc3339(),
    })
}

/// Drop a saved repository. Catalogues imported from it keep their provenance.
#[tauri::command(rename_all = "camelCase")]
pub fn forget_catalog_repo(
    app: AppHandle,
    repo_id: String,
) -> Result<SavedReposView, ShareError> {
    let state = app.state::<CatalogSourceRegistry>();
    let (removed, repos) = state
        .write_checked(&app, |r| {
            let removed = r.forget_saved_repo(&repo_id);
            ((removed, SavedReposView::of(&app, r)), removed)
        })
        .map_err(ShareError::invalid)?;
    if !removed {
        return Err(ShareError::not_found("That repository is not saved"));
    }
    Ok(repos)
}

/// Star one saved repository as the default publish target, or clear it with
/// `None`.
#[tauri::command(rename_all = "camelCase")]
pub fn set_favourite_catalog_repo(
    app: AppHandle,
    repo_id: Option<String>,
) -> Result<SavedReposView, ShareError> {
    let state = app.state::<CatalogSourceRegistry>();
    let (starred, repos) = state
        .write_checked(&app, |r| {
            let starred = r.set_favourite_repo(repo_id);
            ((starred, SavedReposView::of(&app, r)), starred)
        })
        .map_err(ShareError::invalid)?;
    // Reported rather than ignored: the UI stars optimistically and rolls back on
    // error, so a silent refusal would leave a star that reverts later for no
    // visible reason.
    if !starred {
        return Err(ShareError::not_found("That repository is not saved"));
    }
    Ok(repos)
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/// Parse and vet a shared URL, and build a client for it.
///
/// Every command re-parses the URL rather than trusting a repository identity from
/// the frontend, so a browse of one repository cannot be turned into an import from
/// another.
fn open_source(input: &str) -> Result<(CatalogSource, GitHubClient), ShareError> {
    let source = parse_catalog_source(input).map_err(|e| ShareError::invalid(e.message()))?;
    github::require_supported_host(&source)?;
    let client = GitHubClient::new(auth::stored_token(&source.host));
    Ok((source, client))
}

/// Bring the clone for a source up to date, and hand back where it is.
///
/// Every read path goes through here, so nothing else has to know whether this is the
/// first time we have seen the repository. The first call clones (slow, once); every
/// call after it is a fetch.
async fn synced_clone(
    app: &AppHandle,
    source: &CatalogSource,
    git_ref: &str,
) -> Result<git::Synced, ShareError> {
    git::sync(app, &git::RepoSpec::for_source(source, git_ref)).await
}

/// Everything the two single-catalogue commands need from the registry, taken under
/// one lock so the entry, its repository and the local state cannot disagree.
struct TrackedSnapshot {
    filename: String,
    remote_path: String,
    git_ref: String,
    spec: git::RepoSpec,
    label: String,
    synced_sha: String,
    local_state: LocalState,
}

/// Snapshot one tracked catalogue, or report that it is no longer tracked.
///
/// Shared by `fetch_remote_catalog` and `pull_catalog`, which otherwise opened with
/// the same twenty lines and could drift on what "tracked" means.
fn snapshot_tracked(
    app: &AppHandle,
    catalog_id: &str,
    decoder_dir: &std::path::Path,
) -> Result<TrackedSnapshot, ShareError> {
    app.state::<CatalogSourceRegistry>()
        .read(app, |r| {
            let entry = r.catalog_by_id(catalog_id)?;
            let repo = r.repo(&entry.repo_id)?;
            Some(TrackedSnapshot {
                filename: entry.local_filename.clone(),
                remote_path: entry.remote_path.clone(),
                git_ref: entry.git_ref.clone(),
                spec: git::RepoSpec::for_repo(repo, &entry.git_ref),
                label: format!("{}/{}", repo.owner, repo.repo),
                synced_sha: entry.synced_sha.clone(),
                local_state: entry.local_state(decoder_dir),
            })
        })
        .ok_or_else(|| ShareError::not_found("That catalogue is no longer being tracked"))
}

/// Read several catalogues out of the clone.
///
/// Sequential on purpose: these are local object-database reads, so the bounded
/// concurrency the HTTP path needed would buy nothing but complexity.
async fn read_catalogues(
    dir: &std::path::Path,
    git_ref: &str,
    blobs: &[TreeBlob],
) -> Vec<Result<String, ShareError>> {
    let mut texts = Vec::with_capacity(blobs.len());
    for blob in blobs {
        texts.push(
            git::read_blob(dir, git_ref, &blob.path)
                .await
                .map(|read| read.text),
        );
    }
    texts
}

/// Fix up a `/tree/<ref>/<path>` split when the branch name may contain slashes.
///
/// `github.com/o/r/tree/feature/x/catalogs` is either branch `feature` with path
/// `x/catalogs` or branch `feature/x` with path `catalogs`, and the URL cannot say
/// which. The clone already holds every ref, so the answer comes from disk rather than
/// from a `matching-refs` request — which also means it works on any host. If none
/// resolve we leave the guess alone; the subsequent tree read gives a better error
/// than anything we could invent.
async fn resolve_ambiguous_ref(
    clone_dir: &std::path::Path,
    source: &mut CatalogSource,
    repo: &RepoInfo,
) {
    let candidates = url::ref_path_candidates(source);
    if source.reference.is_none() {
        return;
    }
    let known = git::known_refs(clone_dir).await.unwrap_or_default();

    // Candidates come longest-ref-first, so `feature/x` beats `feature`.
    for (candidate_ref, candidate_path) in candidates {
        if candidate_ref == repo.default_branch || known.contains(&candidate_ref) {
            if source.reference.as_deref() != Some(candidate_ref.as_str()) {
                tlog!(
                    "[catalog_share] resolved ambiguous ref for {}: '{}' + path {:?}",
                    repo.full_name,
                    candidate_ref,
                    candidate_path
                );
            }
            source.reference = Some(candidate_ref);
            source.path = candidate_path;
            source.ref_is_ambiguous = false;
            return;
        }
    }
}

fn basename(path: &str) -> &str {
    path.rsplit('/').next().unwrap_or(path)
}

/// `gh:owner/repo` → `owner/repo`, for display when the repo entry is gone.
fn strip_host_prefix(repo_id: &str) -> &str {
    repo_id.split_once(':').map(|(_, rest)| rest).unwrap_or(repo_id)
}

/// Names of the `*.toml` files already in the decoder dir, for collision checks.
fn local_filenames(app: &AppHandle) -> Vec<String> {
    let Some(dir) = crate::catalog::decoder_dir(app) else {
        return Vec::new();
    };
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    entries
        .flatten()
        .filter_map(|e| e.file_name().to_str().map(str::to_string))
        .filter(|name| name.to_lowercase().ends_with(".toml"))
        .collect()
}

fn repo_entry(source: &CatalogSource, repo: &RepoInfo) -> RepoEntry {
    RepoEntry {
        id: source.repo_id(),
        host: source.host.clone(),
        owner: repo.owner.clone(),
        repo: repo.name.clone(),
        default_branch: repo.default_branch.clone(),
        web_url: Some(repo.html_url.clone()),
        fork: None,
        head_commits: Vec::new(),
    }
}

/// Parse and validate a catalogue, extracting what the UI needs to decide whether to
/// import it.
fn describe_catalog(path: &str, blob_sha: &str, text: &str) -> RemoteCatalog {
    let findings = wiretap_catalog::validate::validate(text);
    let errors: Vec<String> = findings
        .iter()
        .map(|f| format!("{}: {}", f.field, f.message))
        .collect();

    let parsed = wiretap_catalog::Catalog::parse(text).ok();
    let (name, frame_count, transmit_frame_count, protocol) = match &parsed {
        Some(cat) => (
            // `Meta` defaults `name` to an empty string, so a non-catalogue TOML
            // parses with a blank name rather than failing. Treat blank as absent so
            // the UI falls back to the file path instead of showing nothing.
            Some(cat.meta.name.trim())
                .filter(|n| !n.is_empty())
                .map(str::to_string),
            cat.frames.len(),
            cat.frames.iter().filter(|f| f.interval.is_some()).count(),
            Some(cat.protocol),
        ),
        None => (None, 0, 0, None),
    };

    RemoteCatalog {
        path: path.to_string(),
        blob_sha: blob_sha.to_string(),
        name,
        valid: findings.is_empty() && parsed.is_some(),
        errors,
        frame_count,
        transmit_frame_count,
        protocol,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parsed(input: &str) -> CatalogSource {
        parse_catalog_source(input).expect("parses")
    }

    fn built(
        input: &str,
        label: Option<&str>,
        git_ref: Option<&str>,
        directory: Option<&str>,
    ) -> SavedRepo {
        saved_repo_from(
            &parsed(input),
            label.map(str::to_string),
            git_ref.map(str::to_string),
            directory.map(str::to_string),
        )
        .expect("builds")
    }

    /// Saving a directory URL should capture where the catalogues live, so the
    /// user does not retype the ref and folder on every publish.
    #[test]
    fn saving_a_directory_url_infers_the_ref_and_directory() {
        let entry = built("https://github.com/o/r/tree/main/catalogs", None, None, None);

        assert_eq!(entry.id, "gh:o/r");
        assert_eq!(entry.url, "https://github.com/o/r");
        assert_eq!(entry.git_ref.as_deref(), Some("main"));
        assert_eq!(entry.directory.as_deref(), Some("catalogs"));
        assert_eq!(entry.label, None);
    }

    /// A file URL names one catalogue. Treating its path as a directory would
    /// scope later browses to a path that is not a folder.
    #[test]
    fn saving_a_file_url_keeps_the_ref_but_not_a_directory() {
        let entry = built("https://github.com/o/r/blob/main/catalogs/x.toml", None, None, None);

        assert_eq!(entry.git_ref.as_deref(), Some("main"));
        assert_eq!(entry.directory, None);
    }

    #[test]
    fn explicit_values_win_over_the_url_and_blanks_are_dropped() {
        let url = "https://github.com/o/r/tree/main/catalogs";

        let entry = built(url, Some("  Shared decoders  "), Some("dev"), Some("decoders"));
        assert_eq!(entry.label.as_deref(), Some("Shared decoders"));
        assert_eq!(entry.git_ref.as_deref(), Some("dev"));
        assert_eq!(entry.directory.as_deref(), Some("decoders"));

        // Whitespace is not a value: fall back to the URL rather than storing "".
        let blank = built(url, Some("   "), Some(""), Some(" "));
        assert_eq!(blank.label, None);
        assert_eq!(blank.git_ref.as_deref(), Some("main"));
        assert_eq!(blank.directory.as_deref(), Some("catalogs"));
    }

    /// The frontend destructures `{ saved, savedRepos, favouriteRepoId }` from this
    /// in one go, which only works if the flatten lands the list beside `saved`
    /// rather than nesting it. `tsc` cannot see a wire-shape mistake.
    #[test]
    fn save_result_flattens_the_list_beside_the_entry() {
        let result = SaveRepoResult {
            saved: built("o/r", None, None, None),
            repos: SavedReposView {
                saved_repos: vec![SavedRepoView {
                    repo: built("o/r", None, None, None),
                    clone_path: "/tmp/gh-o-r".into(),
                    cloned: true,
                }],
                favourite_repo_id: Some("gh:o/r".into()),
            },
        };
        let json: serde_json::Value = serde_json::to_value(&result).expect("serialises");

        assert_eq!(json["saved"]["id"], "gh:o/r");
        assert_eq!(json["savedRepos"][0]["id"], "gh:o/r");
        assert_eq!(json["favouriteRepoId"], "gh:o/r");
        assert!(json["repos"].is_null(), "the view must flatten, not nest");
    }

    /// The pair (default branch, some directory) has no `/tree/` URL that expresses
    /// it — which is exactly why scope is passed as arguments rather than re-encoded
    /// into a URL for the parser to pull back apart.
    #[test]
    fn a_directory_without_a_ref_is_representable() {
        let entry = built("o/r", None, None, Some("catalogs"));
        assert_eq!(entry.git_ref, None);
        assert_eq!(entry.directory.as_deref(), Some("catalogs"));
    }

    /// A directory typed into the edit dialog never went through the URL parser,
    /// so it must still be refused if it tries to escape the repository.
    #[test]
    fn a_traversing_directory_is_refused() {
        for bad in ["../etc", "catalogs/../..", "a/./b"] {
            assert!(
                saved_repo_from(&parsed("o/r"), None, None, Some(bad.into())).is_err(),
                "{bad} should be refused"
            );
        }
    }

    /// Surrounding slashes are a typing habit, not an attempt to escape — they are
    /// normalised so `/catalogs/` and `catalogs` save as the same directory.
    #[test]
    fn surrounding_slashes_are_normalised() {
        for input in ["/catalogs", "catalogs/", "/catalogs/"] {
            let entry = built("o/r", None, None, Some(input));
            assert_eq!(entry.directory.as_deref(), Some("catalogs"), "{input}");
        }
    }

    #[test]
    fn a_bare_repo_url_saves_with_no_ref_or_directory() {
        let entry = built("o/r", None, None, None);
        assert_eq!(entry.url, "https://github.com/o/r");
        assert_eq!(entry.git_ref, None);
        assert_eq!(entry.directory, None);
    }

    #[test]
    fn describe_catalog_reports_name_and_transmit_frames() {
        let toml = r#"
[meta]
name = "Test Device"
version = 1

[meta.can]
default_byte_order = "little"

[frame.can."0x100"]
length = 8
interval_ms = 100

[[frame.can."0x100".signals]]
name = "Voltage"
start_bit = 0
bit_length = 16

[frame.can."0x200"]
length = 8

[[frame.can."0x200".signals]]
name = "Current"
start_bit = 0
bit_length = 16
"#;
        let described = describe_catalog("catalogs/test.toml", "sha", toml);
        assert!(described.valid, "errors: {:?}", described.errors);
        assert_eq!(described.name.as_deref(), Some("Test Device"));
        assert_eq!(described.frame_count, 2);
        assert_eq!(
            described.transmit_frame_count, 1,
            "only 0x100 declares an interval"
        );
        assert_eq!(described.protocol, Some(wiretap_catalog::Protocol::Can));
    }

    /// The protocol goes over the wire through the crate's serde contract, not a
    /// Debug rendering that would drift if a variant became multi-word.
    #[test]
    fn protocol_serialises_as_the_crate_defines_it() {
        let json = serde_json::to_string(&wiretap_catalog::Protocol::Can).expect("serialises");
        assert_eq!(json, "\"can\"");
    }

    /// The last-line filter that keeps non-catalogues out even if the path
    /// heuristics let one through.
    #[test]
    fn describe_catalog_rejects_a_build_manifest() {
        let cargo = "[package]\nname = \"wiretap\"\nversion = \"0.1.0\"\n";
        let described = describe_catalog("Cargo.toml", "sha", cargo);
        assert!(!described.valid);
        assert!(!described.errors.is_empty());
        assert_eq!(described.name, None);
    }

    #[test]
    fn describe_catalog_rejects_malformed_toml() {
        let described = describe_catalog("broken.toml", "sha", "this is not = = toml");
        assert!(!described.valid);
        assert!(!described.errors.is_empty());
    }

    #[test]
    fn basename_takes_the_last_segment() {
        assert_eq!(basename("catalogs/sungrow/shx.toml"), "shx.toml");
        assert_eq!(basename("shx.toml"), "shx.toml");
    }

    #[test]
    fn strip_host_prefix_leaves_owner_repo() {
        assert_eq!(strip_host_prefix("gh:owner/repo"), "owner/repo");
        assert_eq!(strip_host_prefix("ghe.example.com:owner/repo"), "owner/repo");
        assert_eq!(strip_host_prefix("owner/repo"), "owner/repo");
    }

    #[test]
    fn collision_policy_defaults_to_keeping_both() {
        assert_eq!(CollisionPolicy::default(), CollisionPolicy::KeepBoth);
    }

    fn blob(path: &str) -> TreeBlob {
        TreeBlob {
            path: path.to_string(),
            sha: "sha".to_string(),
            size: 10,
        }
    }

    const VALID: &str = "[meta]\nname = \"X\"\nversion = 1\n\n[frame.can.\"0x100\"]\nlength = 8\n";

    fn temp_dir(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "wiretap-import-{tag}-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        std::fs::remove_dir_all(&dir).ok();
        std::fs::create_dir_all(&dir).expect("temp dir");
        dir
    }

    #[test]
    fn write_import_writes_a_new_file() {
        let dir = temp_dir("new");
        let (filename, outcome, name) =
            write_import(&dir, &blob("catalogs/x.toml"), VALID, None, CollisionPolicy::KeepBoth)
                .expect("writes");
        assert_eq!(filename, "x.toml");
        assert_eq!(outcome, ImportOutcome::Imported);
        assert_eq!(name.as_deref(), Some("X"));
        assert_eq!(std::fs::read_to_string(dir.join("x.toml")).unwrap(), VALID);
        std::fs::remove_dir_all(&dir).ok();
    }

    /// Byte-for-byte, including CRLF — the blob SHA is over exactly these bytes.
    #[test]
    fn write_import_preserves_bytes_exactly() {
        let dir = temp_dir("bytes");
        let crlf = VALID.replace('\n', "\r\n");
        write_import(&dir, &blob("x.toml"), &crlf, None, CollisionPolicy::KeepBoth)
            .expect("writes");
        assert_eq!(std::fs::read(dir.join("x.toml")).unwrap(), crlf.as_bytes());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn write_import_honours_each_collision_policy() {
        let dir = temp_dir("collide");
        std::fs::write(dir.join("x.toml"), b"local work").expect("write");

        let (filename, outcome, _) =
            write_import(&dir, &blob("x.toml"), VALID, None, CollisionPolicy::KeepBoth)
                .expect("keeps both");
        assert_eq!(filename, "x-2.toml");
        assert_eq!(outcome, ImportOutcome::Imported);
        assert_eq!(
            std::fs::read_to_string(dir.join("x.toml")).unwrap(),
            "local work",
            "the hand-written file must survive"
        );

        let refused = write_import(&dir, &blob("x.toml"), VALID, None, CollisionPolicy::Skip)
            .expect_err("skips");
        assert_eq!(refused.outcome, ImportOutcome::Skipped);

        write_import(&dir, &blob("x.toml"), VALID, None, CollisionPolicy::Overwrite)
            .expect("overwrites");
        assert_eq!(std::fs::read_to_string(dir.join("x.toml")).unwrap(), VALID);
        std::fs::remove_dir_all(&dir).ok();
    }

    /// A previously imported file is an update in place, whatever the policy —
    /// otherwise re-importing would spawn x-2.toml, x-3.toml, …
    #[test]
    fn write_import_updates_a_tracked_file_in_place() {
        let dir = temp_dir("update");
        std::fs::write(dir.join("renamed.toml"), b"old").expect("write");
        let (filename, outcome, _) = write_import(
            &dir,
            &blob("catalogs/x.toml"),
            VALID,
            Some("renamed.toml".to_string()),
            CollisionPolicy::KeepBoth,
        )
        .expect("updates");
        assert_eq!(filename, "renamed.toml");
        assert_eq!(outcome, ImportOutcome::Updated);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn backup_copies_the_file_aside_into_a_hidden_subdir() {
        let dir = temp_dir("backup");
        std::fs::write(dir.join("x.toml"), b"local work").expect("write");

        back_up_catalogue(&dir, "x.toml", &dir.join("x.toml"));

        let backups: Vec<_> = std::fs::read_dir(dir.join(".wiretap-backups"))
            .expect("backup dir")
            .flatten()
            .collect();
        assert_eq!(backups.len(), 1);
        let name = backups[0].file_name().to_string_lossy().to_string();
        assert!(name.starts_with("x."), "{name}");
        assert!(name.ends_with(".toml"), "{name}");
        assert_eq!(std::fs::read(backups[0].path()).unwrap(), b"local work");

        // The backup lives in a subdirectory, so the non-recursive top-level
        // `*.toml` scan never picks it up as a catalogue.
        let top_level: Vec<String> = std::fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .filter(|e| e.path().extension().is_some_and(|x| x == "toml"))
            .map(|e| e.file_name().to_string_lossy().to_string())
            .collect();
        assert_eq!(top_level, vec!["x.toml"]);
        std::fs::remove_dir_all(&dir).ok();
    }

    /// Nothing to back up must not create the directory or fail.
    #[test]
    fn backup_of_a_missing_file_is_a_noop() {
        let dir = temp_dir("backup-missing");
        back_up_catalogue(&dir, "gone.toml", &dir.join("gone.toml"));
        assert!(!dir.join(".wiretap-backups").exists());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn write_import_refuses_an_invalid_catalogue() {
        let dir = temp_dir("invalid");
        let refused = write_import(
            &dir,
            &blob("Cargo.toml"),
            "[package]\nname = \"x\"\n",
            None,
            CollisionPolicy::KeepBoth,
        )
        .expect_err("refuses");
        assert_eq!(refused.outcome, ImportOutcome::Failed);
        assert!(refused.message.unwrap().contains("not a valid catalogue"));
        assert!(
            std::fs::read_dir(&dir).unwrap().next().is_none(),
            "nothing should be written"
        );
        std::fs::remove_dir_all(&dir).ok();
    }
}
