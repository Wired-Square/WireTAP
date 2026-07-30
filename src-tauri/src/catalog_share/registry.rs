//! Provenance registry: which remote each local catalogue came from, and whether
//! the local copy is committed.
//!
//! Lives as `catalog-sources.json` beside `settings.json` in the app config dir.
//! Deliberately *not* in the catalogue TOML itself: that file gets committed
//! upstream, and "which fork I push to" / "what sha I last synced" is per-user,
//! per-machine state that has no business travelling with the decoder.
//!
//! ## The sync-state model
//!
//! For every tracked catalogue we store the **git blob SHA-1 of the exact bytes
//! last exchanged with the remote**. That is the same identifier GitHub returns in
//! its trees and contents responses, so one stored value answers two questions —
//! and the local one needs no network at all:
//!
//! | comparison                          | meaning                        |
//! |-------------------------------------|--------------------------------|
//! | `sha1(file) == synced_sha`          | committed, nothing to publish  |
//! | `sha1(file) != synced_sha`          | uncommitted local changes      |
//! | `remote_sha != synced_sha`          | upstream has moved             |
//! | both differ, and remote != local    | diverged, needs review         |

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use sha1::{Digest, Sha1};
use tauri::{AppHandle, Manager};

const REGISTRY_FILE: &str = "catalog-sources.json";
const SCHEMA_VERSION: u32 = 1;

/// Compute the git blob SHA-1 of some bytes: `sha1("blob {len}\0" + bytes)`.
///
/// Matches `git hash-object` exactly, which is the whole point — it lets us compare
/// a local file against a GitHub tree entry without fetching anything.
pub fn git_blob_sha(bytes: &[u8]) -> String {
    let mut hasher = Sha1::new();
    hasher.update(format!("blob {}\0", bytes.len()).as_bytes());
    hasher.update(bytes);
    hex::encode(hasher.finalize())
}

/// Blob SHA of a file on disk, or `None` if it cannot be read.
pub fn git_blob_sha_of_file(path: &Path) -> Option<String> {
    std::fs::read(path).ok().map(|bytes| git_blob_sha(&bytes))
}

/// How the local file compares with the bytes last exchanged with the remote.
/// Computed from disk alone — no network.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum LocalState {
    /// No provenance entry — a purely local catalogue.
    Untracked,
    /// Byte-identical to what we last pushed or pulled.
    Committed,
    /// Edited since the last exchange.
    Modified,
    /// Tracked, but the file is gone.
    Missing,
}

/// How the remote compares. Only meaningful after an update check.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RemoteState {
    Unknown,
    InSync,
    UpstreamAhead,
    Diverged,
}

/// The repository half of a subscription.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoEntry {
    /// Stable key from `CatalogSource::repo_id()`, e.g. `gh:{owner}/{repo}`.
    pub id: String,
    pub host: String,
    pub owner: String,
    pub repo: String,
    pub default_branch: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub web_url: Option<String>,
    /// The user's fork, once one exists. Set by the publish flow.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fork: Option<ForkRef>,
    /// Head commit at the last update check, **per ref**, so a check can skip
    /// listing a tree that cannot have changed.
    ///
    /// Per ref rather than per repository because a repository tracked at two refs
    /// has two heads; one shared field would be overwritten by whichever ref was
    /// checked last, and the short-circuit would then never fire for either.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub head_commits: Vec<RefHead>,
}

/// A repository the user has chosen to keep, independent of whether any
/// catalogue currently comes from it.
///
/// Deliberately *not* a flag on [`RepoEntry`]: that list is garbage-collected by
/// [`Registry::forget`] as soon as its last catalogue is forgotten, which would
/// silently drop a repository the user had explicitly saved.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedRepo {
    /// Stable key from `CatalogSource::repo_id()` — same identity as `RepoEntry`.
    pub id: String,
    /// Canonical repository URL. Fed verbatim to `PublishRequest::repo_url`, which
    /// re-parses it, so the frontend never hands the backend a bare identity.
    pub url: String,
    pub owner: String,
    pub repo: String,
    /// Display name; falls back to `{owner}/{repo}` when unset.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    /// Ref to browse and import from. **Not** the publish branch — see
    /// `PublishRequest::branch`, which names a branch to create.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub git_ref: Option<String>,
    /// Repo-relative directory holding catalogues, e.g. `catalogs`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub directory: Option<String>,
    pub saved_at: String,
}

/// The head commit last seen on one ref.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RefHead {
    pub git_ref: String,
    pub commit: String,
}

/// A pull request worth polling, with everything needed to ask about it.
#[derive(Debug, Clone)]
pub struct OpenPull {
    pub catalog_id: String,
    pub owner: String,
    pub repo: String,
    pub number: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ForkRef {
    pub owner: String,
    pub repo: String,
}

impl RepoEntry {
    /// Canonical `https://{host}/{owner}/{repo}` — the clone URL, and the base for a
    /// commit link.
    ///
    /// Shares the host normalisation with `CatalogSource::repo_url`: a repository first
    /// reached through a `raw.githubusercontent.com` URL stores that host verbatim, and
    /// `https://raw.githubusercontent.com/o/r` is not a clonable remote.
    pub fn repo_url(&self) -> String {
        let host = match self.host.as_str() {
            "raw.githubusercontent.com" => "github.com",
            other => other,
        };
        format!("https://{host}/{}/{}", self.owner, self.repo)
    }

    /// Head commit last seen on a ref, if this repository has been checked at it.
    pub fn head_for_ref(&self, git_ref: &str) -> Option<String> {
        self.head_commits
            .iter()
            .find(|h| h.git_ref == git_ref)
            .map(|h| h.commit.clone())
    }
}

/// Publish bookkeeping for one catalogue.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishState {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pr_number: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pr_url: Option<String>,
    /// Whether that PR has landed. Pushed is not the same as merged, and for
    /// collaboration the difference is what people actually want to see.
    #[serde(default)]
    pub merged: bool,
}

/// One tracked catalogue.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogEntry {
    /// Derived from the subscription's natural key, so it survives a local rename
    /// and a re-import of the same remote file.
    pub id: String,
    pub repo_id: String,
    pub remote_path: String,
    pub git_ref: String,
    /// Git blob SHA-1 of the bytes last exchanged with the remote.
    pub synced_sha: String,
    /// Filename within the decoder dir. Keyed on the filename rather than an
    /// absolute path because the decoder dir is a user setting and iOS container
    /// UUIDs go stale.
    pub local_filename: String,
    pub imported_at: String,
    /// Last seen upstream sha, from an update check.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote_sha: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub publish: Option<PublishState>,
}

/// The stable id for a subscription: repository, path within it, and ref.
///
/// Not derived from the local filename — that changes on rename, which would both
/// break an in-flight relink and give the same subscription a new React key.
pub fn catalog_entry_id(repo_id: &str, remote_path: &str, git_ref: &str) -> String {
    let slug: String = format!("{repo_id}:{remote_path}@{git_ref}")
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
        .collect();
    format!("cs_{slug}")
}

impl CatalogEntry {
    /// Does this entry describe the given remote file?
    pub fn matches_remote(&self, repo_id: &str, remote_path: &str, git_ref: &str) -> bool {
        self.repo_id == repo_id && self.remote_path == remote_path && self.git_ref == git_ref
    }

    /// Record that these exact bytes are what the remote holds — the one operation
    /// that moves both halves of the sync-state model at once.
    pub fn mark_exchanged(&mut self, blob_sha: String) {
        self.remote_sha = Some(blob_sha.clone());
        self.synced_sha = blob_sha;
    }

    /// Local sync state, by hashing the file on disk.
    ///
    /// Bytes matching `remote_sha` count as committed too — that is how accepting an
    /// upstream update reads, whichever route wrote the file (the editor's ordinary
    /// save, a copy in Finder, anything). Derived rather than promoted on write for
    /// exactly that reason, and it mirrors the "your bytes landed" rule
    /// [`Self::remote_state`] already applies. `synced_sha` is left alone because
    /// publish and `reconcile` both key off it.
    pub fn local_state(&self, decoder_dir: &Path) -> LocalState {
        match git_blob_sha_of_file(&decoder_dir.join(&self.local_filename)) {
            None => LocalState::Missing,
            Some(sha) if sha == self.synced_sha => LocalState::Committed,
            Some(sha) if self.remote_sha.as_deref() == Some(sha.as_str()) => LocalState::Committed,
            Some(_) => LocalState::Modified,
        }
    }

    /// Remote sync state. `remote_sha` is only populated by an update check, so this
    /// reports `Unknown` until one has run.
    pub fn remote_state(&self, local: LocalState, decoder_dir: Option<&Path>) -> RemoteState {
        let Some(remote_sha) = self.remote_sha.as_deref() else {
            return RemoteState::Unknown;
        };
        if remote_sha == self.synced_sha {
            return RemoteState::InSync;
        }
        // Upstream moved. Whether that is a clean fast-forward or a divergence
        // depends on whether we also have local edits.
        if local != LocalState::Modified {
            return RemoteState::UpstreamAhead;
        }
        // If upstream happens to match our local bytes, the work has landed.
        let local_sha = decoder_dir
            .and_then(|dir| git_blob_sha_of_file(&dir.join(&self.local_filename)));
        if local_sha.as_deref() == Some(remote_sha) {
            RemoteState::InSync
        } else {
            RemoteState::Diverged
        }
    }
}

/// The cached GitHub identity. Whether a token exists lives in the keychain; this is
/// only what we resolved it to, so the UI can show a login without a round trip.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitIdentity {
    pub host: String,
    pub login: String,
    #[serde(default)]
    pub scopes: Vec<String>,
    pub validated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Registry {
    #[serde(default = "default_schema")]
    pub schema: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub identity: Option<GitIdentity>,
    /// Repositories the user has saved. Survives catalogue GC — see [`SavedRepo`].
    #[serde(default)]
    pub saved_repos: Vec<SavedRepo>,
    /// The one saved repository used as the default publish target. An id rather
    /// than a per-entry flag, matching `default_read_profile` in `AppSettings`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub favourite_repo_id: Option<String>,
    #[serde(default)]
    pub repos: Vec<RepoEntry>,
    #[serde(default)]
    pub catalogs: Vec<CatalogEntry>,
}

fn default_schema() -> u32 {
    SCHEMA_VERSION
}

impl Default for Registry {
    fn default() -> Self {
        Self {
            schema: SCHEMA_VERSION,
            identity: None,
            saved_repos: Vec::new(),
            favourite_repo_id: None,
            repos: Vec::new(),
            catalogs: Vec::new(),
        }
    }
}

impl Registry {
    pub fn repo(&self, repo_id: &str) -> Option<&RepoEntry> {
        self.repos.iter().find(|r| r.id == repo_id)
    }

    pub fn catalog_for_remote(
        &self,
        repo_id: &str,
        remote_path: &str,
        git_ref: &str,
    ) -> Option<&CatalogEntry> {
        self.catalogs
            .iter()
            .find(|c| c.matches_remote(repo_id, remote_path, git_ref))
    }

    pub fn catalog_by_filename(&self, filename: &str) -> Option<&CatalogEntry> {
        self.catalogs
            .iter()
            .find(|c| filename_eq(&c.local_filename, filename))
    }

    pub fn catalog_by_id(&self, id: &str) -> Option<&CatalogEntry> {
        self.catalogs.iter().find(|c| c.id == id)
    }

    pub fn catalog_by_id_mut(&mut self, id: &str) -> Option<&mut CatalogEntry> {
        self.catalogs.iter_mut().find(|c| c.id == id)
    }

    pub fn catalog_by_filename_mut(&mut self, filename: &str) -> Option<&mut CatalogEntry> {
        self.catalogs
            .iter_mut()
            .find(|c| filename_eq(&c.local_filename, filename))
    }

    fn repo_mut(&mut self, repo_id: &str) -> Option<&mut RepoEntry> {
        self.repos.iter_mut().find(|r| r.id == repo_id)
    }

    /// Mutate one entry in place, reporting whether it was found.
    ///
    /// Callers must not hand-roll the lookup: `filename_eq` owns the
    /// case-insensitivity rule (see its comment), and a publish path that misses
    /// the entry silently opens a rival pull request against a fresh path instead
    /// of adding a commit to the existing one.
    pub fn update_catalog_by_filename(
        &mut self,
        filename: &str,
        f: impl FnOnce(&mut CatalogEntry),
    ) -> bool {
        self.catalog_by_filename_mut(filename).map(f).is_some()
    }

    /// Mutate one entry by id, reporting whether it was found.
    pub fn update_catalog_by_id(&mut self, id: &str, f: impl FnOnce(&mut CatalogEntry)) -> bool {
        self.catalog_by_id_mut(id).map(f).is_some()
    }

    /// Record the fork of an upstream, so later publishes reuse it rather than
    /// re-probing (which guesses the wrong name when GitHub suffixed it `-1`).
    pub fn set_fork(&mut self, repo_id: &str, fork: ForkRef) {
        if let Some(repo) = self.repo_mut(repo_id) {
            repo.fork = Some(fork);
        }
    }

    /// Insert or replace the repository entry, preserving fork and check state the
    /// caller did not supply.
    pub fn upsert_repo(&mut self, mut entry: RepoEntry) {
        if let Some(existing) = self.repos.iter().position(|r| r.id == entry.id) {
            let previous = &self.repos[existing];
            entry.fork = entry.fork.or_else(|| previous.fork.clone());
            if entry.head_commits.is_empty() {
                entry.head_commits = previous.head_commits.clone();
            }
            self.repos[existing] = entry;
        } else {
            self.repos.push(entry);
        }
    }

    /// Pull requests still worth polling — open, with a number, and resolvable to a
    /// repository. Merged ones are skipped: once landed the answer cannot change, and
    /// re-polling them spends a request per click.
    pub fn open_pulls(&self, repo_id: Option<&str>, catalog_id: Option<&str>) -> Vec<OpenPull> {
        self.catalogs
            .iter()
            .filter(|c| repo_id.is_none_or(|id| id == c.repo_id))
            .filter(|c| catalog_id.is_none_or(|id| id == c.id))
            .filter_map(|c| {
                let publish = c.publish.as_ref()?;
                let number = publish.pr_number?;
                let repo = self.repo(&c.repo_id)?;
                (!publish.merged).then(|| OpenPull {
                    catalog_id: c.id.clone(),
                    owner: repo.owner.clone(),
                    repo: repo.repo.clone(),
                    number,
                })
            })
            .collect()
    }

    /// Record the upstream sha for a catalogue. Returns whether it moved, so a batch
    /// write can tell whether anything is worth persisting.
    pub fn set_remote_sha(&mut self, catalog_id: &str, sha: &str) -> bool {
        let Some(entry) = self.catalog_by_id_mut(catalog_id) else {
            return false;
        };
        if entry.remote_sha.as_deref() == Some(sha) {
            return false;
        }
        entry.remote_sha = Some(sha.to_string());
        true
    }

    /// Record the head commit seen on a ref. Returns whether it moved.
    pub fn set_head_for_ref(&mut self, repo_id: &str, git_ref: &str, commit: &str) -> bool {
        let Some(repo) = self.repo_mut(repo_id) else {
            return false;
        };
        match repo.head_commits.iter_mut().find(|h| h.git_ref == git_ref) {
            Some(head) if head.commit == commit => return false,
            Some(head) => head.commit = commit.to_string(),
            None => repo.head_commits.push(RefHead {
                git_ref: git_ref.to_string(),
                commit: commit.to_string(),
            }),
        }
        true
    }

    /// Insert or replace the catalogue entry, keyed on filename.
    pub fn upsert_catalog(&mut self, entry: CatalogEntry) {
        if let Some(existing) = self
            .catalogs
            .iter()
            .position(|c| filename_eq(&c.local_filename, &entry.local_filename))
        {
            self.catalogs[existing] = entry;
        } else {
            self.catalogs.push(entry);
        }
    }

    /// Save a repository, or update the one already held under the same id.
    ///
    /// The first save becomes the favourite: a one-entry list with nothing
    /// starred would leave the publish dropdown with no default for no reason.
    pub fn save_repo(&mut self, mut entry: SavedRepo) {
        match self.saved_repos.iter_mut().find(|r| r.id == entry.id) {
            Some(existing) => {
                // Keep when it was first saved; this is an edit, not a re-add.
                entry.saved_at = existing.saved_at.clone();
                *existing = entry;
            }
            None => {
                if self.saved_repos.is_empty() {
                    self.favourite_repo_id = Some(entry.id.clone());
                }
                self.saved_repos.push(entry);
            }
        }
    }

    /// Drop a saved repository. Returns whether anything was removed.
    ///
    /// Clears the favourite when it was the one removed — otherwise the publish
    /// dropdown defaults to an id that is no longer in the list.
    pub fn forget_saved_repo(&mut self, repo_id: &str) -> bool {
        let before = self.saved_repos.len();
        self.saved_repos.retain(|r| r.id != repo_id);
        let removed = self.saved_repos.len() != before;
        if removed && self.favourite_repo_id.as_deref() == Some(repo_id) {
            self.favourite_repo_id = None;
        }
        removed
    }

    /// Star one saved repository, or clear the star with `None`. Reports whether it
    /// took: an id that is not in the list is refused, so the caller can say so
    /// rather than leave the UI showing a star that silently reverts.
    pub fn set_favourite_repo(&mut self, repo_id: Option<String>) -> bool {
        let known = repo_id
            .as_deref()
            .is_none_or(|id| self.saved_repos.iter().any(|r| r.id == id));
        if known {
            self.favourite_repo_id = repo_id;
        }
        known
    }

    /// Drop a catalogue entry by filename. Returns whether anything was removed.
    pub fn forget_filename(&mut self, filename: &str) -> bool {
        self.forget(|c| filename_eq(&c.local_filename, filename))
    }

    /// Drop a catalogue entry by id. Returns whether anything was removed.
    pub fn forget_id(&mut self, id: &str) -> bool {
        self.forget(|c| c.id == id)
    }

    fn forget(&mut self, matches: impl Fn(&CatalogEntry) -> bool) -> bool {
        let before = self.catalogs.len();
        self.catalogs.retain(|c| !matches(c));
        let removed = self.catalogs.len() != before;
        if removed {
            // Keep only repositories some catalogue still references.
            let referenced: HashSet<&str> =
                self.catalogs.iter().map(|c| c.repo_id.as_str()).collect();
            self.repos.retain(|r| referenced.contains(r.id.as_str()));
        }
        removed
    }

    /// Point an entry at a new filename, following an in-app rename.
    pub fn rename_filename(&mut self, old: &str, new: &str) -> bool {
        // If the destination already had an entry, the rename replaces it.
        self.catalogs
            .retain(|c| !filename_eq(&c.local_filename, new) || filename_eq(&c.local_filename, old));
        match self
            .catalogs
            .iter_mut()
            .find(|c| filename_eq(&c.local_filename, old))
        {
            Some(entry) => {
                entry.local_filename = new.to_string();
                true
            }
            None => false,
        }
    }

    /// Reconcile against the decoder directory, following renames made outside the
    /// app. Returns whether anything changed (so the caller can skip a disk write).
    ///
    /// A missing file is matched by content against the other catalogues in the
    /// directory. Hashing is lazy: in the normal case, where every tracked file is
    /// present, nothing is read beyond the directory listing.
    ///
    /// This complements — and does not duplicate — the in-app rename hook. The hook
    /// covers a rename of a *modified* file, which content matching cannot, because
    /// `synced_sha` describes the last-exchanged bytes rather than what is on disk.
    pub fn reconcile(&mut self, decoder_dir: &Path) -> bool {
        let present = list_toml_filenames(decoder_dir);
        let missing: Vec<usize> = self
            .catalogs
            .iter()
            .enumerate()
            .filter(|(_, c)| !present.iter().any(|n| filename_eq(n, &c.local_filename)))
            .map(|(i, _)| i)
            .collect();
        if missing.is_empty() {
            return false;
        }

        // Only now is hashing worth it. Files already claimed by a tracked entry
        // are not rename candidates.
        let claimed: HashSet<String> = self
            .catalogs
            .iter()
            .map(|c| c.local_filename.to_lowercase())
            .collect();
        let unclaimed: Vec<(String, String)> = present
            .iter()
            .filter(|name| !claimed.contains(&name.to_lowercase()))
            .filter_map(|name| {
                git_blob_sha_of_file(&decoder_dir.join(name)).map(|sha| (name.clone(), sha))
            })
            .collect();

        let mut changed = false;
        for index in missing {
            let entry = &self.catalogs[index];
            let mut matches = unclaimed.iter().filter(|(_, sha)| *sha == entry.synced_sha);
            // Exactly one match, or we would be guessing.
            if let (Some((name, _)), None) = (matches.next(), matches.next()) {
                tlog!(
                    "[catalog_share] relinked {} → {} by content hash",
                    entry.local_filename,
                    name
                );
                self.catalogs[index].local_filename = name.clone();
                changed = true;
            }
        }
        changed
    }
}

/// Filenames compare case-insensitively — macOS is case-insensitive, so
/// `Catalog.toml` and `catalog.toml` are the same file there.
fn filename_eq(a: &str, b: &str) -> bool {
    a.eq_ignore_ascii_case(b)
}

/// Names of every `*.toml` at the top level of the decoder dir. Names only: the
/// common reconcile path needs no file contents.
fn list_toml_filenames(decoder_dir: &Path) -> Vec<String> {
    let Ok(entries) = std::fs::read_dir(decoder_dir) else {
        return Vec::new();
    };
    entries
        .flatten()
        .filter_map(|entry| {
            let path = entry.path();
            let is_toml = path
                .extension()
                .and_then(|e| e.to_str())
                .is_some_and(|e| e.eq_ignore_ascii_case("toml"));
            is_toml
                .then(|| path.file_name()?.to_str().map(str::to_string))
                .flatten()
        })
        .collect()
}

// ── Managed state ────────────────────────────────────────────────────────────

/// Tauri-managed registry, mirroring the shape of `CatalogCache` in `catalog.rs`.
#[derive(Default)]
pub struct CatalogSourceRegistry {
    inner: Mutex<Option<Registry>>,
}

impl CatalogSourceRegistry {
    /// Read the registry, loading from disk on first use.
    pub fn read<T>(&self, app: &AppHandle, f: impl FnOnce(&Registry) -> T) -> T {
        let mut guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        let registry = guard.get_or_insert_with(|| load(app));
        f(registry)
    }

    /// Mutate the registry and persist it unconditionally.
    pub fn write<T>(&self, app: &AppHandle, f: impl FnOnce(&mut Registry) -> T) -> T {
        self.mutate(app, |r| (f(r), true)).0
    }

    /// Mutate the registry, persisting only when the closure reports a change.
    ///
    /// Used by read-mostly paths like `reconcile`, which would otherwise rewrite
    /// `catalog-sources.json` on every invocation to record nothing.
    pub fn write_if(&self, app: &AppHandle, f: impl FnOnce(&mut Registry) -> bool) -> bool {
        let (changed, _) = self.mutate(app, |r| {
            let changed = f(r);
            (changed, changed)
        });
        changed
    }

    /// Mutate and persist, reporting a write failure to the caller.
    ///
    /// For state the *user* typed and expects to keep — the saved repositories.
    /// Provenance can be swallowed on failure because it is re-derived on the next
    /// browse; a curated list cannot, or the UI reports a repository saved when
    /// nothing reached disk and it is gone at the next restart.
    /// The closure reports whether it changed anything, so a refused mutation does
    /// not rewrite the file to record nothing — same rule as [`Self::write_if`].
    pub fn write_checked<T>(
        &self,
        app: &AppHandle,
        f: impl FnOnce(&mut Registry) -> (T, bool),
    ) -> Result<T, String> {
        let mut guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        let registry = guard.get_or_insert_with(|| load(app));
        let (result, changed) = f(registry);
        if changed {
            save(app, registry)?;
        }
        Ok(result)
    }

    fn mutate<T>(&self, app: &AppHandle, f: impl FnOnce(&mut Registry) -> (T, bool)) -> (T, bool) {
        let mut guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        let registry = guard.get_or_insert_with(|| load(app));
        let (result, should_save) = f(registry);
        if should_save {
            if let Err(e) = save(app, registry) {
                // Provenance is advisory; a failed write must not fail the command.
                tlog!("[catalog_share] failed to persist registry: {}", e);
            }
        }
        (result, should_save)
    }
}

fn registry_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("Failed to get app config dir: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("Failed to create app config dir: {e}"))?;
    Ok(dir.join(REGISTRY_FILE))
}

fn load(app: &AppHandle) -> Registry {
    let Ok(path) = registry_path(app) else {
        return Registry::default();
    };
    if !path.exists() {
        return Registry::default();
    }
    match std::fs::read_to_string(&path).map(|c| serde_json::from_str::<Registry>(&c)) {
        Ok(Ok(registry)) => registry,
        Ok(Err(e)) => {
            // A corrupt registry must not block the app: provenance is advisory.
            tlog!(
                "[catalog_share] registry at {:?} is unreadable ({}); starting fresh",
                path,
                e
            );
            Registry::default()
        }
        Err(e) => {
            tlog!("[catalog_share] could not read registry: {}", e);
            Registry::default()
        }
    }
}

fn save(app: &AppHandle, registry: &Registry) -> Result<(), String> {
    let path = registry_path(app)?;
    let json = serde_json::to_string_pretty(registry)
        .map_err(|e| format!("Failed to serialise registry: {e}"))?;
    crate::catalog::write_file_atomically(&path, json.as_bytes())
}

// ── Lifecycle hooks, called from catalog.rs ──────────────────────────────────

/// Follow an in-app rename so provenance is not lost.
pub fn on_catalog_renamed(app: &AppHandle, old_filename: &str, new_filename: &str) {
    app.state::<CatalogSourceRegistry>()
        .write_if(app, |r| r.rename_filename(old_filename, new_filename));
}

/// Drop provenance for a deleted catalogue.
///
/// Note the asymmetry with an out-of-app delete, which leaves the entry in place
/// for `reconcile` to report as missing: an in-app delete is explicit intent, so it
/// forgets the subscription outright.
pub fn on_catalog_deleted(app: &AppHandle, filename: &str) {
    app.state::<CatalogSourceRegistry>()
        .write_if(app, |r| r.forget_filename(filename));
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(filename: &str, sha: &str) -> CatalogEntry {
        let remote_path = format!("catalogs/{filename}");
        CatalogEntry {
            id: catalog_entry_id("gh:owner/repo", &remote_path, "main"),
            repo_id: "gh:owner/repo".to_string(),
            remote_path,
            git_ref: "main".to_string(),
            synced_sha: sha.to_string(),
            local_filename: filename.to_string(),
            imported_at: "2026-07-30T00:00:00Z".to_string(),
            remote_sha: None,
            publish: None,
        }
    }

    fn repo() -> RepoEntry {
        RepoEntry {
            id: "gh:owner/repo".to_string(),
            host: "github.com".to_string(),
            owner: "owner".to_string(),
            repo: "repo".to_string(),
            default_branch: "main".to_string(),
            web_url: None,
            fork: None,
            head_commits: Vec::new(),
        }
    }

    /// A saved repo whose id is `gh:{owner}/{repo}`, mirroring `repo_id()`.
    fn saved(id: &str) -> SavedRepo {
        let (owner, repo) = id.trim_start_matches("gh:").split_once('/').expect("owner/repo");
        SavedRepo {
            id: id.to_string(),
            url: format!("https://github.com/{owner}/{repo}"),
            owner: owner.to_string(),
            repo: repo.to_string(),
            label: None,
            git_ref: None,
            directory: None,
            saved_at: "2026-01-01T00:00:00Z".to_string(),
        }
    }

    impl Registry {
        /// Test-only lookup; production code reaches entries via `catalog_for_remote`
        /// or by iterating `catalogs`.
        fn by_filename(&self, filename: &str) -> Option<&CatalogEntry> {
            self.catalogs
                .iter()
                .find(|c| filename_eq(&c.local_filename, filename))
        }

        fn state_of(&self, decoder_dir: &Path, filename: &str) -> LocalState {
            self.by_filename(filename)
                .map(|e| e.local_state(decoder_dir))
                .unwrap_or(LocalState::Untracked)
        }
    }

    /// Scratch dir per test, since several write real files.
    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "wiretap-registry-{tag}-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        std::fs::remove_dir_all(&dir).ok();
        std::fs::create_dir_all(&dir).expect("temp dir");
        dir
    }

    /// The load-bearing property: our hash must equal `git hash-object`.
    /// Values verified with `printf '%s' "<content>" | git hash-object --stdin`.
    #[test]
    fn a_raw_host_normalises_to_a_clonable_remote() {
        // A repository first reached through a raw.githubusercontent.com URL keeps
        // that host; cloning it verbatim would fail with nothing useful to say.
        let entry = RepoEntry {
            id: "gh:o/r".into(),
            host: "raw.githubusercontent.com".into(),
            owner: "o".into(),
            repo: "r".into(),
            default_branch: "main".into(),
            web_url: None,
            fork: None,
            head_commits: Vec::new(),
        };
        assert_eq!(entry.repo_url(), "https://github.com/o/r");
    }

    #[test]
    fn blob_sha_matches_git_hash_object() {
        assert_eq!(
            git_blob_sha(b""),
            "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391"
        );
        assert_eq!(
            git_blob_sha(b"hello"),
            "b6fc4c620b67d95f953a5c1c1230aaab5db5a1b0"
        );
        assert_eq!(
            git_blob_sha(b"hello\n"),
            "ce013625030ba8dba906f756967f9e9ca394464a"
        );
    }

    /// Byte-exactness matters: line-ending or trailing-newline drift is a real diff
    /// on GitHub, so it must be a real difference here too.
    #[test]
    fn blob_sha_is_sensitive_to_line_endings_and_trailing_newline() {
        let lf = git_blob_sha(b"[meta]\nname = \"X\"\n");
        let crlf = git_blob_sha(b"[meta]\r\nname = \"X\"\r\n");
        let no_trailing = git_blob_sha(b"[meta]\nname = \"X\"");
        assert_ne!(lf, crlf);
        assert_ne!(lf, no_trailing);
    }

    /// The id must not move when the local file is renamed, and must be identical
    /// for a re-import of the same remote file.
    #[test]
    fn entry_id_is_derived_from_the_subscription_not_the_filename() {
        let a = catalog_entry_id("gh:owner/repo", "catalogs/x.toml", "main");
        assert_eq!(a, catalog_entry_id("gh:owner/repo", "catalogs/x.toml", "main"));
        assert_ne!(a, catalog_entry_id("gh:owner/repo", "catalogs/x.toml", "dev"));
        assert_ne!(a, catalog_entry_id("gh:other/repo", "catalogs/x.toml", "main"));
        assert!(a.starts_with("cs_"));
        assert!(
            a.chars().all(|c| c == '_' || c.is_ascii_alphanumeric()),
            "id must be safe to use as a key: {a}"
        );
    }

    #[test]
    fn round_trips_through_json() {
        let mut registry = Registry::default();
        registry.upsert_repo(repo());
        registry.upsert_catalog(entry("x.toml", "abc"));
        registry.save_repo(saved("gh:owner/repo"));

        let json = serde_json::to_string(&registry).expect("serialises");
        let parsed: Registry = serde_json::from_str(&json).expect("deserialises");

        assert_eq!(parsed.schema, SCHEMA_VERSION);
        assert_eq!(parsed.catalogs.len(), 1);
        assert_eq!(parsed.catalogs[0].synced_sha, "abc");
        assert_eq!(parsed.repos.len(), 1);
        assert_eq!(parsed.saved_repos, vec![saved("gh:owner/repo")]);
        assert_eq!(parsed.favourite_repo_id.as_deref(), Some("gh:owner/repo"));
    }

    #[test]
    fn empty_json_object_loads_as_default() {
        let parsed: Registry = serde_json::from_str("{}").expect("tolerates a bare object");
        assert_eq!(parsed.schema, SCHEMA_VERSION);
        assert!(parsed.catalogs.is_empty());
        assert!(parsed.saved_repos.is_empty());
        assert!(parsed.favourite_repo_id.is_none());
    }

    #[test]
    fn rename_moves_the_entry() {
        let mut registry = Registry::default();
        registry.upsert_catalog(entry("old.toml", "abc"));
        assert!(registry.rename_filename("old.toml", "new.toml"));
        assert!(registry.by_filename("old.toml").is_none());
        assert_eq!(
            registry.by_filename("new.toml").unwrap().synced_sha,
            "abc"
        );
    }

    #[test]
    fn rename_onto_an_existing_name_replaces_it() {
        let mut registry = Registry::default();
        registry.upsert_catalog(entry("a.toml", "aaa"));
        registry.upsert_catalog(entry("b.toml", "bbb"));
        assert!(registry.rename_filename("a.toml", "b.toml"));
        assert_eq!(registry.catalogs.len(), 1);
        assert_eq!(
            registry.by_filename("b.toml").unwrap().synced_sha,
            "aaa"
        );
    }

    #[test]
    fn filenames_compare_case_insensitively() {
        let mut registry = Registry::default();
        registry.upsert_catalog(entry("Catalog.toml", "abc"));
        assert!(registry.by_filename("catalog.toml").is_some());
        // An upsert of the other casing replaces rather than duplicates.
        registry.upsert_catalog(entry("catalog.toml", "def"));
        assert_eq!(registry.catalogs.len(), 1);
    }

    #[test]
    fn delete_drops_entry_and_unreferenced_repo() {
        let mut registry = Registry::default();
        registry.upsert_repo(repo());
        registry.upsert_catalog(entry("x.toml", "abc"));
        assert!(registry.forget_filename("x.toml"));
        assert!(registry.catalogs.is_empty());
        assert!(
            registry.repos.is_empty(),
            "repo should be pruned with its last catalogue"
        );
        assert!(!registry.forget_filename("x.toml"), "second delete is a no-op");
    }

    #[test]
    fn delete_keeps_repo_while_another_catalogue_references_it() {
        let mut registry = Registry::default();
        registry.upsert_repo(repo());
        registry.upsert_catalog(entry("x.toml", "abc"));
        registry.upsert_catalog(entry("y.toml", "def"));
        registry.forget_filename("x.toml");
        assert_eq!(registry.repos.len(), 1);
    }

    #[test]
    fn upsert_repo_preserves_fork_and_check_state() {
        let mut registry = Registry::default();
        let mut first = repo();
        first.fork = Some(ForkRef {
            owner: "me".into(),
            repo: "repo".into(),
        });
        first.head_commits = vec![RefHead {
            git_ref: "main".into(),
            commit: "head1".into(),
        }];
        registry.upsert_repo(first);

        // A later browse knows nothing about the fork; it must not clear it.
        registry.upsert_repo(repo());
        let stored = registry.repo("gh:owner/repo").expect("still present");
        assert_eq!(stored.fork.as_ref().unwrap().owner, "me");
        assert_eq!(stored.head_for_ref("main").as_deref(), Some("head1"));
    }

    /// Two refs of one repository must not share a head record, or whichever was
    /// checked last overwrites the other and neither ever short-circuits.
    #[test]
    fn head_commits_are_tracked_per_ref() {
        let mut registry = Registry::default();
        registry.upsert_repo(repo());

        assert!(registry.set_head_for_ref("gh:owner/repo", "main", "h1"));
        assert!(registry.set_head_for_ref("gh:owner/repo", "dev", "h2"));
        let stored = registry.repo("gh:owner/repo").expect("present");
        assert_eq!(stored.head_for_ref("main").as_deref(), Some("h1"));
        assert_eq!(stored.head_for_ref("dev").as_deref(), Some("h2"));
        assert_eq!(stored.head_for_ref("nope"), None);

        // Recording the same commit again is not a change, so it must not trigger a
        // registry write.
        assert!(!registry.set_head_for_ref("gh:owner/repo", "main", "h1"));
        assert!(registry.set_head_for_ref("gh:owner/repo", "main", "h3"));
        assert_eq!(
            registry
                .repo("gh:owner/repo")
                .unwrap()
                .head_for_ref("main")
                .as_deref(),
            Some("h3")
        );
        // Updating one ref leaves the other alone.
        assert_eq!(
            registry
                .repo("gh:owner/repo")
                .unwrap()
                .head_for_ref("dev")
                .as_deref(),
            Some("h2")
        );
    }

    #[test]
    fn set_head_for_an_unknown_repo_is_a_noop() {
        let mut registry = Registry::default();
        assert!(!registry.set_head_for_ref("gh:nope/nope", "main", "h1"));
    }

    /// A saved repository is the user saying "keep this", so it must outlive the
    /// catalogues that happen to come from it. `forget` prunes `repos`; if saved
    /// repositories lived there too, forgetting the last catalogue would silently
    /// delete the publish target.
    #[test]
    fn a_saved_repo_survives_forgetting_its_last_catalogue() {
        let mut registry = Registry::default();
        registry.upsert_repo(repo());
        registry.upsert_catalog(entry("x.toml", "abc"));
        registry.save_repo(saved("gh:owner/repo"));

        assert!(registry.forget_filename("x.toml"));

        assert!(registry.repos.is_empty(), "repo entry is GC'd, as before");
        assert_eq!(registry.saved_repos.len(), 1, "the saved repo is not");
    }

    #[test]
    fn the_first_saved_repo_becomes_the_favourite() {
        let mut registry = Registry::default();
        registry.save_repo(saved("gh:a/one"));
        assert_eq!(registry.favourite_repo_id.as_deref(), Some("gh:a/one"));

        // A later save must not steal the star.
        registry.save_repo(saved("gh:b/two"));
        assert_eq!(registry.favourite_repo_id.as_deref(), Some("gh:a/one"));
    }

    #[test]
    fn saving_the_same_id_updates_in_place_and_keeps_saved_at() {
        let mut registry = Registry::default();
        registry.save_repo(saved("gh:owner/repo"));

        let mut edited = saved("gh:owner/repo");
        edited.label = Some("Shared decoders".into());
        edited.saved_at = "2030-01-01T00:00:00Z".into();
        registry.save_repo(edited);

        assert_eq!(registry.saved_repos.len(), 1);
        let stored = &registry.saved_repos[0];
        assert_eq!(stored.label.as_deref(), Some("Shared decoders"));
        assert_eq!(stored.saved_at, "2026-01-01T00:00:00Z", "an edit is not a re-add");
    }

    /// Without this the publish dropdown defaults to an id that is no longer in
    /// the list — the same rule `removeProfile` applies to `defaultReadProfile`.
    #[test]
    fn forgetting_the_favourite_clears_the_star() {
        let mut registry = Registry::default();
        registry.save_repo(saved("gh:a/one"));
        registry.save_repo(saved("gh:b/two"));
        registry.set_favourite_repo(Some("gh:b/two".into()));

        assert!(registry.forget_saved_repo("gh:b/two"));
        assert!(registry.favourite_repo_id.is_none());

        // Forgetting a non-favourite leaves the star alone.
        registry.set_favourite_repo(Some("gh:a/one".into()));
        registry.save_repo(saved("gh:c/three"));
        assert!(registry.forget_saved_repo("gh:c/three"));
        assert_eq!(registry.favourite_repo_id.as_deref(), Some("gh:a/one"));
    }

    #[test]
    fn favouriting_an_unknown_id_is_ignored() {
        let mut registry = Registry::default();
        registry.save_repo(saved("gh:a/one"));
        registry.set_favourite_repo(Some("gh:nope/nope".into()));
        assert_eq!(
            registry.favourite_repo_id.as_deref(),
            Some("gh:a/one"),
            "an id not in the list must not become the default"
        );

        registry.set_favourite_repo(None);
        assert!(registry.favourite_repo_id.is_none(), "None clears it");
    }

    #[test]
    fn matches_remote_requires_all_three_parts() {
        let e = entry("x.toml", "abc");
        assert!(e.matches_remote("gh:owner/repo", "catalogs/x.toml", "main"));
        assert!(!e.matches_remote("gh:other/repo", "catalogs/x.toml", "main"));
        assert!(!e.matches_remote("gh:owner/repo", "catalogs/y.toml", "main"));
        assert!(!e.matches_remote("gh:owner/repo", "catalogs/x.toml", "dev"));
    }

    #[test]
    fn local_state_reflects_the_file_on_disk() {
        let dir = temp_dir("local-state");
        let content = b"[meta]\nname = \"X\"\n";
        let sha = git_blob_sha(content);
        std::fs::write(dir.join("x.toml"), content).expect("write");

        let mut registry = Registry::default();
        registry.upsert_catalog(entry("x.toml", &sha));
        assert_eq!(registry.state_of(&dir, "x.toml"), LocalState::Committed);

        std::fs::write(dir.join("x.toml"), b"[meta]\nname = \"Y\"\n").expect("write");
        assert_eq!(registry.state_of(&dir, "x.toml"), LocalState::Modified);

        std::fs::remove_file(dir.join("x.toml")).expect("remove");
        assert_eq!(registry.state_of(&dir, "x.toml"), LocalState::Missing);

        assert_eq!(
            registry.state_of(&dir, "untracked.toml"),
            LocalState::Untracked
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn remote_state_is_unknown_until_a_check_has_run() {
        let e = entry("x.toml", "aaa");
        assert_eq!(
            e.remote_state(LocalState::Committed, None),
            RemoteState::Unknown
        );
    }

    #[test]
    fn remote_state_distinguishes_upstream_ahead_from_diverged() {
        let mut e = entry("x.toml", "aaa");
        e.remote_sha = Some("aaa".into());
        assert_eq!(
            e.remote_state(LocalState::Committed, None),
            RemoteState::InSync
        );

        e.remote_sha = Some("bbb".into());
        assert_eq!(
            e.remote_state(LocalState::Committed, None),
            RemoteState::UpstreamAhead
        );
        assert_eq!(
            e.remote_state(LocalState::Modified, None),
            RemoteState::Diverged
        );
    }

    /// Accepting an upstream update writes the remote bytes through the ordinary save
    /// path, which knows nothing about provenance. Reading those bytes as committed is
    /// therefore derived, not promoted on write — so it holds however the file got
    /// there (the editor, a copy in Finder, anything).
    #[test]
    fn bytes_matching_the_remote_read_as_committed() {
        let dir = temp_dir("derive-committed");
        let remote = b"[meta]\nname = \"Upstream\"\n";

        let mut registry = Registry::default();
        let mut e = entry("x.toml", "old-local");
        e.remote_sha = Some(git_blob_sha(remote));
        registry.upsert_catalog(e);

        std::fs::write(dir.join("x.toml"), remote).expect("write");
        assert_eq!(registry.state_of(&dir, "x.toml"), LocalState::Committed);

        // `synced_sha` is deliberately untouched: publish and `reconcile` both key
        // off it, so the promotion is a read-time view, not a mutation.
        assert_eq!(
            registry.by_filename("x.toml").unwrap().synced_sha,
            "old-local"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    /// Bytes matching neither the synced nor the remote sha are the user's own work.
    #[test]
    fn bytes_matching_neither_read_as_modified() {
        let dir = temp_dir("derive-modified");
        let mut registry = Registry::default();
        let mut e = entry("x.toml", git_blob_sha(b"synced").as_str());
        e.remote_sha = Some(git_blob_sha(b"upstream"));
        registry.upsert_catalog(e);

        std::fs::write(dir.join("x.toml"), b"my own edit").expect("write");
        assert_eq!(registry.state_of(&dir, "x.toml"), LocalState::Modified);
        std::fs::remove_dir_all(&dir).ok();
    }

    /// A merged PR shows up as upstream matching our local bytes exactly.
    #[test]
    fn remote_state_reconciles_when_upstream_matches_local_bytes() {
        let dir = temp_dir("landed");
        let content = b"[meta]\nname = \"X\"\n";
        let local_sha = git_blob_sha(content);
        std::fs::write(dir.join("x.toml"), content).expect("write");

        let mut e = entry("x.toml", "old-synced");
        e.remote_sha = Some(local_sha);
        assert_eq!(
            e.remote_state(LocalState::Modified, Some(&dir)),
            RemoteState::InSync
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn reconcile_is_a_noop_when_every_file_is_present() {
        let dir = temp_dir("noop");
        let content = b"[meta]\nname = \"X\"\n";
        std::fs::write(dir.join("x.toml"), content).expect("write");

        let mut registry = Registry::default();
        registry.upsert_catalog(entry("x.toml", &git_blob_sha(content)));
        assert!(
            !registry.reconcile(&dir),
            "nothing missing, so nothing to persist"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn reconcile_relinks_an_out_of_app_rename_by_content() {
        let dir = temp_dir("relink");
        let content = b"[meta]\nname = \"X\"\n";
        let sha = git_blob_sha(content);
        // Registry says x.toml; on disk it has been renamed to renamed.toml.
        std::fs::write(dir.join("renamed.toml"), content).expect("write");

        let mut registry = Registry::default();
        registry.upsert_catalog(entry("x.toml", &sha));
        assert!(registry.reconcile(&dir));
        assert_eq!(registry.catalogs[0].local_filename, "renamed.toml");
        std::fs::remove_dir_all(&dir).ok();
    }

    /// Regression: a mixed-case filename must still relink. An earlier version
    /// indexed both the real and lowercased names, so one file looked like two
    /// candidates and the entry was never relinked.
    #[test]
    fn reconcile_relinks_a_mixed_case_filename() {
        let dir = temp_dir("mixedcase");
        let content = b"[meta]\nname = \"X\"\n";
        let sha = git_blob_sha(content);
        std::fs::write(dir.join("Renamed.TOML"), content).expect("write");

        let mut registry = Registry::default();
        registry.upsert_catalog(entry("x.toml", &sha));
        assert!(registry.reconcile(&dir), "should relink, not give up");
        assert_eq!(registry.catalogs[0].local_filename, "Renamed.TOML");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn reconcile_leaves_the_entry_when_content_is_ambiguous() {
        let dir = temp_dir("ambiguous");
        let content = b"[meta]\nname = \"X\"\n";
        let sha = git_blob_sha(content);
        // Two identical files — ambiguous, so we must not guess.
        std::fs::write(dir.join("one.toml"), content).expect("write");
        std::fs::write(dir.join("two.toml"), content).expect("write");

        let mut registry = Registry::default();
        registry.upsert_catalog(entry("gone.toml", &sha));
        assert!(!registry.reconcile(&dir), "no confident match, no change");
        assert_eq!(registry.catalogs[0].local_filename, "gone.toml");
        assert_eq!(registry.state_of(&dir, "gone.toml"), LocalState::Missing);
        std::fs::remove_dir_all(&dir).ok();
    }

    /// A file already claimed by another tracked entry is not a rename candidate.
    #[test]
    fn reconcile_does_not_steal_a_claimed_file() {
        let dir = temp_dir("claimed");
        let content = b"[meta]\nname = \"X\"\n";
        let sha = git_blob_sha(content);
        std::fs::write(dir.join("kept.toml"), content).expect("write");

        let mut registry = Registry::default();
        registry.upsert_catalog(entry("kept.toml", &sha));
        registry.upsert_catalog(entry("gone.toml", &sha));
        assert!(!registry.reconcile(&dir));
        assert_eq!(registry.by_filename("kept.toml").unwrap().synced_sha, sha);
        assert!(registry.by_filename("gone.toml").is_some());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn lists_only_top_level_toml_names() {
        let dir = temp_dir("listing");
        std::fs::write(dir.join("a.toml"), b"x").expect("write");
        std::fs::write(dir.join("B.TOML"), b"x").expect("write");
        std::fs::write(dir.join("c.dbc"), b"x").expect("write");
        std::fs::write(dir.join("report.html"), b"x").expect("write");
        std::fs::create_dir_all(dir.join("dashboards")).expect("subdir");

        let mut names = list_toml_filenames(&dir);
        names.sort();
        assert_eq!(names, vec!["B.TOML", "a.toml"]);
        std::fs::remove_dir_all(&dir).ok();
    }
}
