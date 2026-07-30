# Catalogue Sharing over Git

How WireTAP pulls decoder catalogues from a repository someone shared, and pushes
yours back. This is the canonical reference for `src-tauri/src/catalog_share/`.

For how catalogues are seeded, cached and watched locally, see
[catalog-and-decoder-loading in the docs vault] — the local cache
(`CatalogCache`, the `notify` watcher, the `CatalogListChanged` WS push) is
described alongside `src-tauri/src/catalog.rs`.

---

## Real clones, plus REST for what git has no concept of

Each saved repository is cloned with **libgit2** (the `git2` crate) into
`<app_data>/repos/{repo_id}`. Pull is a fetch, push is a commit plus a push, and
the result is an ordinary git repository the `git` binary can open.

This replaced an earlier design that emulated git over the GitHub contents API —
roughly 600 lines of `github.rs` listing trees, reading blobs, creating refs and
PUTing files. That version was GitHub-only, could not express ahead/behind, and
forced every push through a branch and a pull request because the contents API was
the only transport available.

Forks and pull requests really are GitHub *product* concepts rather than git
operations, so `github.rs` still exists — it is just much smaller, and is no longer
on the path for moving files.

**Why `git2` and not the alternatives.** `gix` cannot push (checked early 2026);
shelling out to the `git` binary is impossible on iOS, which ships. libgit2 is
plain C, builds for every target WireTAP ships, and is proven on iOS in production
apps.

**TLS backend differs per platform** — SecureTransport on macOS and iOS, WinHTTP on
Windows, OpenSSL on Linux. `libgit2-sys` declares `openssl-sys` under a blanket
`cfg(unix)` that catches both Apple targets even though neither calls it, so both
vendor OpenSSL purely to satisfy the dependency graph; without it the iOS
cross-compile fails outright hunting for a host OpenSSL. Linux vendors it because
it genuinely uses it and CI installs no `libssl-dev`. See the comments in
`src-tauri/Cargo.toml`; the real fix is upstream narrowing that cfg.

**SSH is deliberately not enabled.** The `ssh` feature pulls libssh2 onto four
platforms, and the keychain token over HTTPS covers every supported host today.

All HTTP lives in Rust because the app's CSP (`tauri.conf.json`,
`app.security.csp`) blocks `connect-src` to `api.github.com`. `check_for_updates`
in `settings.rs` is the same pattern.

### Where the clones live

`<app_data>/repos/{repo_id with non-alphanumerics folded to `-`}` — one directory per
saved repository, derived on every call and **never persisted**, because iOS container
UUIDs change between installs. That is why the path reaches the UI only as part of a
listing (`SavedRepoView.clonePath`, alongside `cloned`) or from `repo_status`, and is
never stored in `catalog-sources.json`. A directory that exists but will not open (an app
suspended mid-clone, a purged container, a half-restored backup) is re-cloned rather
than repaired; that one rule is what makes every one of those cases recover with no
special handling.

Only the push path checks the working tree out. Every read — `list_catalogues`,
`read_blob`, `known_refs`, `ahead_behind` — resolves from `refs/remotes/origin/{ref}`
in the object database, so `align_branch` moves the ref and stops there. Checking out
on every sync meant a whole-tree diff, and on a branch switch a rewrite of every file,
for work that was then thrown away.

### The clone is transport and mirror, not a workspace

WireTAP never leaves a clone divergent. `git::sync` fast-forwards the local branch
to `origin` and **hard-resets it when they have diverged** — safe precisely because
the clone is not where anything is authored. The content of record is the file in
the decoder directory; a clone-local commit that never reached the remote is a
failed push, not user work.

That invariant is what lets the module skip merge, rebase and conflict resolution
entirely. When the local file has edits *and* upstream moved, the existing diff
review is shown and the user chooses. There is no merge UI and there should not be
one.

These are Tauri `invoke` commands, **not** `catalog.*` WebSocket commands: that
surface is deliberately pure (text in, JSON out, no `AppHandle`, filesystem,
settings or keychain), and its 10 s timeout would be blown by a fork poll.

---

## Module map

| File | Role |
|---|---|
| `catalog_share/mod.rs` | Command surface for browse/import/saved-repos/tracked-sources/updates; shared wire types |
| `catalog_share/url.rs` | `CatalogSource`, `parse_catalog_source` — every accepted URL form |
| `catalog_share/git.rs` | The git transport — the only module that knows `git2` exists |
| `catalog_share/github.rs` | REST client for forks, pull requests and repository metadata |
| `catalog_share/registry.rs` | Provenance registry: entries, blob SHAs, sync state, saved repositories |
| `catalog_share/publish.rs` | The publish step machine: resolve, fork if needed, commit, push, optional PR |
| `catalog_share/secrets.rs` | Pre-publish credential scan |
| `catalog_share/auth.rs` | Keychain token resolution and the account commands |
| `catalog_share/error.rs` | `ShareError` / `ShareErrorKind` — the module's error type |

Frontend: `src/api/catalogShare.ts` (wrappers + TS mirrors),
`src/stores/catalogShareStore.ts`, `src/apps/catalog/dialogs/{PublishCatalog,
GitHubToken,CreateCatalogRepo,CatalogUpdate}Dialog.tsx`,
`src/apps/catalog/components/CatalogShareDialogs.tsx` (those four, which
interlink, shared by the Catalog editor and Settings → Catalogs), and
`src/dialogs/catalog-share/RepositoryDialog.tsx` — mounted by whoever offers the
button (the shared catalogue picker, and Settings → Catalogs), because unlike the
other four it hands off to none of them. Also
`src/hooks/useCatalogSources.ts` — the catalogue list joined with its provenance,
both reconciled off the same `CatalogListChanged` push via the shared
`src/hooks/useWsResync.ts` primitive (also used by `useCatalogList`,
`useOpenAppsSync` and `useSessionRosterSync`).

---

## The sync-state model

The load-bearing idea. For every tracked catalogue the registry stores the **git
blob SHA-1 of the exact bytes last exchanged with the remote** —
`sha1("blob {len}\0" + bytes)`, which is what `git hash-object` computes and what
GitHub returns in its trees and contents responses. One stored value therefore
answers both questions, and the local one needs **no network call**:

| Comparison | Meaning |
|---|---|
| `sha1(file on disk) == syncedSha` | committed — nothing to publish |
| `sha1(file on disk) != syncedSha` | **uncommitted local changes** |
| `remoteSha != syncedSha` | upstream has moved |
| both differ, and remote ≠ local | diverged — needs review |
| `remoteSha == sha1(file)` | your PR merged, or someone pushed your bytes |

```rust
enum LocalState  { Untracked, Committed, Modified, Missing }   // disk only
enum RemoteState { Unknown, InSync, UpstreamAhead, Diverged }  // needs a check
```

`registry::git_blob_sha` is pinned to `git hash-object` by a conformance test.
Because the hash is over *exact bytes*, CRLF and trailing-newline differences
change it — correctly, since they would be a real diff on GitHub too. **Import
and publish must therefore preserve bytes verbatim and never normalise line
endings.**

Distinct from all of the above is *"has my work landed upstream?"* — a merged PR.
That is tracked separately (`PublishState.pr_number` + `refresh_pr_status`),
because pushed and merged are different things and for collaboration the
difference is what people want to see.

---

### One status for the UI

The two states above are orthogonal and both are needed to be honest about what is
knowable without a network call. The UI wants a single label, so
`src/utils/catalogSync.ts` collapses them exactly once, and both the badge and the
row's menu read that — they cannot disagree about which state a catalogue is in.

| Status | Meaning |
|---|---|
| `localOnly` | Not tracked against any repository |
| `inSync` | Local and remote both match the last exchange |
| `localAhead` | Edited locally; the repository has not moved |
| `remoteAhead` | The repository moved; the local copy is clean |
| `diverged` | Both moved — the only state needing a decision |
| `missing` | Tracked, but the file is gone |
| `unchecked` | Tracked, but no check has run, so the remote side is unknown |

Two subtleties worth keeping: `missing` outranks everything, because with nothing on
disk every other label would be fiction; and `unchecked` is kept distinct from
`inSync`, because "no check has run" and "checked, and current" are different claims.

The rule that a one-click pull never runs over local edits is enforced in **Rust**,
twice — `CatalogEntry::remote_state` weighs the local state and returns `Diverged`
rather than `UpstreamAhead`, and `pull_catalog` refuses again before writing. The TS
collapse deliberately does *not* re-implement it: a second, lower-authority copy would
mask a regression in the first rather than catch it.

`repo_status` additionally reports true `ahead`/`behind` commit counts from
`graph_ahead_behind` — the honest per-repository version of the same question, which
the blob-SHA model cannot express.

---

## Provenance registry

`catalog-sources.json`, in the app config dir beside `settings.json`.

Deliberately **not** in the catalogue TOML: that file gets committed upstream,
and "which fork I push to" / "what sha I last synced" is per-user, per-machine
state that has no business travelling with the decoder. A per-file
`.provenance` sidecar was also rejected — it would litter the directory the user
browses in Finder and has nowhere for repo-level state.

```jsonc
{
  "schema": 1,
  "identity": { "host": "github.com", "login": "…", "scopes": ["public_repo"], "validatedAt": "…" },
  // Repositories the user saved. Survives the `repos` GC below — the whole
  // reason it is a separate array — and one of them is the publish default.
  "savedRepos": [{
    "id": "gh:owner/repo",            // same key as `repos`, from repo_id()
    "url": "https://github.com/owner/repo",   // canonical; fed to PublishRequest.repoUrl
    "owner": "…", "repo": "…",
    "label": "Shared decoders",       // optional; UI falls back to owner/repo
    "gitRef": "main",                 // optional; browse/import only, NOT the publish branch
    "directory": "catalogs",          // optional; seeds the publish target path
    "savedAt": "…"
  }],
  "favouriteRepoId": "gh:owner/repo", // the one starred as the publish default
  "repos": [{
    "id": "gh:owner/repo",            // host-derived, so GHE/GitLab cannot collide
    "host": "github.com", "owner": "…", "repo": "…",
    "defaultBranch": "main",
    "fork": { "owner": "…", "repo": "…" },   // set by publish; read before re-probing
    // Head commit per ref, so a repo tracked at two refs keeps two records —
    // one shared field would be overwritten by whichever ref was checked last.
    "headCommits": [{ "gitRef": "main", "commit": "…" }]
  }],
  "catalogs": [{
    "id": "cs_…",                     // from repo+path+ref, so it survives a rename
    "repoId": "gh:owner/repo",
    "remotePath": "catalogs/x.toml", "gitRef": "main",
    "syncedSha": "…",                 // blob SHA of the bytes last exchanged
    "localFilename": "x.toml",
    "importedAt": "…",
    // "remoteSha" appears once an update check has run (omitted when unset)
    "publish": { "branch": "…", "prNumber": 42, "prUrl": "…", "merged": false }
  }]
}
```

`repos` is **garbage-collected**: `forget` drops any entry no catalogue still
references. `savedRepos` is not — that is why saving a repository cannot be a
flag on `repos`, and why the two lists coexist. `favouriteRepoId` is an id on the
registry rather than a per-entry flag, matching `default_read_profile` in
`AppSettings`; `forget_saved_repo` clears it when the starred entry goes, or the
publish dropdown would default to something no longer in the list.

Saved repositories are the one part of this file the user typed, so the three
commands that mutate them go through `write_checked` and **report a failed
write** — unlike the provenance paths, which log and continue because a lost
`syncedSha` is re-derived on the next browse. `set_favourite_repo` likewise
reports a refused id rather than ignoring it, because the UI stars optimistically
and needs the error to roll back.

Keyed on **filename**, not absolute path: the decoder dir is a user setting
(`handle_decoder_dir_change`) and iOS container UUIDs go stale
(`paths_are_stale`). Resolved as `decoder_dir.join(localFilename)`.

**Do not hand-roll entry lookup.** `registry::filename_eq` owns the
case-insensitivity rule (macOS is case-insensitive); go through
`catalog_by_filename` / `update_catalog_by_filename` / `_by_id`. A publish path
that misses its entry silently opens a *rival* pull request against a fresh path
instead of adding a commit to the existing one.

### Following renames — three layers, each covering what the previous cannot

1. **In-app rename** → `catalog.rs::rename_catalog` calls
   `registry::on_catalog_renamed`. This is the only layer that can follow a
   rename of a *modified* file, because `syncedSha` describes the last-exchanged
   bytes rather than what is on disk.
2. **Out-of-app rename** → `Registry::reconcile` matches a missing entry against
   unclaimed files by content hash, and only relinks on exactly one match.
   Hashing is lazy: with every tracked file present, nothing is read beyond the
   directory listing.
3. **Neither worked** → the entry reports `LocalState::Missing` and the user can
   forget it.

In-app **delete** forgets the entry outright (explicit intent); an out-of-app
delete leaves it reporting missing. `duplicate_catalog` deliberately does *not*
copy provenance — two local files claiming one upstream path would make
publishing ambiguous.

---

## Command surface

All `#[tauri::command(rename_all = "camelCase")]`, registered in `lib.rs`.

```rust
// Discovery / import — mod.rs
parse_catalog_source_url(input) -> CatalogSource        // no network
browse_catalog_repo(app, input, gitRef?, directory?) -> RepoBrowse
resolve_remote_catalogs(app, input, gitRef, paths) -> Vec<RemoteCatalog>
import_remote_catalogs(app, req: ImportRequest) -> Vec<ImportResult>

// Saved repositories — mod.rs. Each returns the refreshed list, so callers patch
// state rather than re-listing (which would hash every tracked catalogue). Every
// row is a SavedRepoView: the stored entry plus clonePath + cloned.
save_catalog_repo(app, input, label?, gitRef?, directory?) -> SaveRepoResult
forget_catalog_repo(app, repoId) -> SavedReposView        // NotFound if unsaved
set_favourite_catalog_repo(app, repoId: Option<String>) -> SavedReposView

// Tracked sources — mod.rs
list_catalog_sources(app) -> CatalogSourcesView          // includes LocalState
forget_catalog_source(app, catalogId) -> ()
refresh_pr_status(app, catalogId) -> Option<TrackedPr>    // open, or merged

// Updates — mod.rs
check_catalog_updates(app, repoId: Option<String>) -> UpdateCheckResult
pull_catalog(app, catalogId) -> PullOutcome    // applies when nothing is at stake
fetch_remote_catalog(app, catalogId) -> RemoteCatalogText
apply_catalog_update(app, catalogId, toml, expectedLocalSha) -> ()

// Clone status — mod.rs. No network; reads what is on disk.
repo_status(app, repoId) -> RepoStatus         // path, branch, ahead/behind

// Account — auth.rs. The token never crosses the IPC boundary.
set_git_token(app, host, token) -> GitIdentity            // validates first
get_git_identity(app, host) -> Option<GitIdentity>
verify_git_token(app, host) -> GitIdentity
clear_git_token(app, host) -> ()
git_token_setup_url() -> String

// Publish — publish.rs
preflight_publish(app, req) -> PublishPlan                // nothing written
publish_catalog(app, req) -> PublishResult
create_catalog_repo(req: NewRepo) -> RepoInfo
```

---

## Accepted URL forms

Parsed in Rust (`url.rs`) so browse, import and publish cannot disagree about
what a URL meant:

```
https://github.com/owner/repo            (also .git, trailing /)
https://github.com/owner/repo/tree/main/catalogs
https://github.com/owner/repo/blob/main/catalogs/x.toml
https://raw.githubusercontent.com/owner/repo/main/catalogs/x.toml
git@github.com:owner/repo.git
ssh://git@github.com/owner/repo.git
owner/repo                               (shorthand)
```

`/pull/…`, `/issues/…`, `/commit/…` are rejected with a message naming what was
pasted. Non-GitHub hosts **parse successfully** and are rejected at the API layer
(`require_supported_host`), so the error is about capability rather than syntax.

`tree/{ref}/{path}` is genuinely ambiguous when a branch name contains slashes
(`tree/feature/x/catalogs`). `ref_path_candidates` yields candidates
longest-ref-first and one `git/matching-refs/heads/{prefix}` request resolves
them; the guess is left alone if none match, because the subsequent tree call
gives a better error.

`CatalogSource::scope()` is the repo-relative subtree. **All three of browse,
resolve and import must apply it** — an unscoped listing can truncate away
(`MAX_CANDIDATES`) a file that was visible when browsing a subdirectory.

---

## Request budget

The anonymous API limit is **60 requests/hour** (5000 authenticated). Now that git
moves the files, almost nothing is charged against it:

- **Enumerating and reading catalogues costs no API requests at all.** A clone or
  fetch is git protocol, not the REST API, and is not rate-limited the same way.
  Browse, resolve and import together spend exactly **one** `GET /repos/{o}/{r}`,
  for the default branch, visibility and push access.
- An update check spends **zero** API requests per repository — a fetch per
  repository+ref, plus one `GET /pulls/{n}` per open pull request. The head-commit
  comparison now short-circuits the *tree walk*, which is local, so it saves work
  rather than bandwidth; the fetch itself is the cost and happens either way.
- Reviewing an update reads from the clone. `fetch_remote_catalog` fetches first,
  so the bytes reviewed are current rather than whatever a previous check recorded —
  the old stale-`remote_sha` fallback is gone.
- `publish_catalog` resolves its plan **once** (`resolve()` returns the plan
  alongside the client, repo and file bytes) rather than re-running the preflight
  command and repeating its lookups.
- Publishing spends one `GET /repos`, plus fork and pull-request calls only when
  those are actually asked for.

What this replaced: a recursive tree request per browse, a single-slot 5-minute
`TreeCache` to stop browse → resolve → import costing three of them, blob fetches
routed to unmetered `raw.githubusercontent.com` when anonymous, and bounded
concurrency over both. All of that existed to fit inside 60 requests/hour, and all
of it is gone.

Clones are **full, not shallow**: libgit2 has no partial-clone support, and shallow
clones make later pushes host-dependent. Catalogue repositories are TOML, so this is
cheap — but a first browse of a large repository is slower than the old tree listing
was, which is why `catalog-git-progress` exists.

Rate-limit headers are read on every response; a 403 with zero remaining becomes
`ShareErrorKind::RateLimited` with a reset estimate and a nudge to add a token.

### Endpoints used

Everything git can do goes through the clone; what is left is what git has no
concept of.

| Purpose | Endpoint |
|---|---|
| Repository facts (default branch, visibility, push access) | `GET /repos/{o}/{r}` |
| Validate token | `GET /user` (scopes from `x-oauth-scopes`) |
| Create repository | `POST /user/repos` (`auto_init: true`) |
| Fork | `POST /repos/{o}/{r}/forks` |
| Find / open PR | `GET\|POST /repos/{o}/{r}/pulls` (find filters on `head` **and** `base`) |
| PR state | `GET /repos/{o}/{r}/pulls/{n}` |

Retired with the REST transport: tree listing, blob fetch, the raw CDN, branch
head lookup, branch creation, contents PUT, `merge-upstream`, and `matching-refs`
(ref disambiguation now reads the clone's own refs, which also makes it work on
any host).

---

## Import

1. `browse_catalog_repo` → one `GET /repos` for repository facts, then clone-or-
   fetch, then a **local tree walk** filtered to `.toml` blobs under the source's
   scope, excluding build manifests (`Cargo.toml`, `pyproject.toml`, …) and
   vendored trees (`node_modules/`, `target/`, `.github/`, …) by **path segment**,
   not substring. The first browse of a repository clones it and is therefore
   slower; it emits `catalog-git-progress` so that is visible.
2. `resolve_remote_catalogs` reads and parses selected files **out of the clone**
   to fill in `[meta].name`, protocol, frame count, transmit-frame count and
   validity — so a broken catalogue is visible as broken *before* import.
3. `import_remote_catalogs` reads from the clone, then per file: validate →
   sanitise filename → resolve collision → write into the decoder directory.

A local tree walk **cannot be truncated**, so the old "this repository is too large
for GitHub to list" failure mode is gone. `TreeListing::truncated` and its warning
string were deleted rather than left permanently false; `dropped` remains, because
[`MAX_CANDIDATES`] can still cap what the UI is asked to render.

Rules that matter:

- **Validate before writing.** This is a schema check, not a security boundary —
  it is what stops a stray `Cargo.toml`, not a hostile author.
- Filenames go through `catalog::sanitise_catalog_filename` (shared with the MCP
  write tools and the duplicate/rename commands).
- Writes go through `catalog::write_file_atomically` (temp + rename), so neither
  the watcher nor a concurrent `scan_catalogs` observes a half-written TOML.
- Collision policy defaults to **KeepBoth** (`name-2.toml`). Never silently
  clobber a hand-written catalogue: without local git history that is
  unrecoverable. A file we previously imported from the same source is an
  *update*, not a collision, whatever the policy says.
- `refresh_catalog_cache` is called **once** per batch. On iOS this is not an
  optimisation — there is no filesystem watcher, so it is the only thing that
  updates the list.
- Caps: `MAX_CATALOG_BYTES` (2 MB), `MAX_CANDIDATES` (200), `MAX_FRAMES` (5000).

### Importing a local file

The catalogue picker's **Import** offers the same destination without a repository:
`catalog::import_catalog` (in `catalog.rs`, not this module) takes a filename plus
content and lands it in the decoder directory, sharing
`sanitise_catalog_filename`, `next_free_catalog_filename`, `write_file_atomically`
and `refresh_catalog_cache` with the git path above. Two deliberate differences:
the collision suffix is resolved against the **directory**, and there is **no
validation** — a stranger's repository earns the schema check, whereas a file the
user picked themselves is often a broken catalogue on its way to the editor to be
fixed. DBC conversion happens first, in the frontend, over the existing
`catalog.import_dbc` WS command.

---

## Publish

### Branches and pull requests are optional

The default is a direct commit to the base branch: no branch created, no pull
request opened. Most publishing is a decoder going back to a repository the user
owns, where a branch and a PR are ceremony around a one-file change.

`PublishRequest` carries exactly two knobs, replacing the three overlapping ones
(`mode`, `commit_to_base`, `branch`) the REST design needed:

- `branch: Option<String>` — `None` pushes to the base branch; naming one creates
  it off the base.
- `open_pr: bool` — off by default, and **never forced**, not even when a fork is
  involved: pushing to your own fork and stopping is a legitimate way to park work.

Opening a PR without naming a branch uses `catalog/{slug}`; a PR against the branch
it would be opened from is refused, since GitHub cannot merge a branch into itself.

`PublishPlan` deliberately carries **no `will_open_pr`**. It reports `fork_needed`
and `suggested_branch` — facts about the repository and the filename — and the
frontend derives the rest. A request-dependent field on the plan would stale it
every time a checkbox moved and force a network round trip per click.

### Sequence

`publish_catalog` runs the sequence below. **Every step is idempotent by
construction**, so recovery from a mid-flight failure is simply pressing Publish
again. There is deliberately **no rollback** — deleting a branch or fork on
failure risks destroying someone's work.

1. **Resolve** — parse the URL (never trust a repository identity from the
   frontend), require a token, read the **saved file from disk** (never the
   editor buffer; there is no code path by which the buffer could reach here),
   validate, scan for secrets, fetch repository facts, derive the plan.
2. **Block** on validation errors, or on unacknowledged secret findings.
3. **Fork, only when needed** — reached only without `permissions.push`. The
   recorded `RepoEntry.fork` is tried first, then `{login}/{repo}`, then
   `POST /forks`. The fork's **`full_name` comes from the response** because
   GitHub appends `-1` when you already own a repository of that name. Forking is
   eventually consistent, so it polls immediately then backs off.
4. **Commit and push** — `git::commit_and_push` syncs the clone, creates the
   branch off `origin/{base}` if it does not exist, writes the file into the
   working tree, stages, commits and pushes. When a fork is the target it pushes
   to an **anonymous remote** so a renamed or deleted fork cannot leave a stale
   entry in the user's `git remote -v`.

   libgit2 reports a server-side rejection through the `push_update_reference`
   callback and **still returns `Ok`** from `push`, so that callback is the only
   way to tell a rejected push from a successful one. It is checked.
5. **Pull request**, when asked for — look before you leap: the push just updated
   any open PR on the branch, so creating a second would be wrong. `find_open_pull`
   filters on **`base` as well as `head`**, because the base now varies with a
   catalogue's provenance and an open PR against a different base is not this one.
6. **Persist** — the pushed blob sha becomes `synced_sha`, so the file immediately
   reads as in sync. The branch is recorded, and reused by a later publish while
   its PR is open and unmerged, so a second edit adds a commit to the review under
   way instead of opening a rival PR the branch-keyed lookup would never find.

---

## Update check

`check_catalog_updates` batches per repository **and ref**:

0. Group targets by **repository**. A repository tracked at two refs is two targets
   sharing one clone directory: fetching them concurrently would pull the same remote
   twice and put two libgit2 handles into the same repository at once. Groups run
   concurrently at `GIT_CONCURRENCY` (3, deliberately below the REST
   `FETCH_CONCURRENCY` of 6 — the first check after upgrading has no clones yet, so
   this is the number of simultaneous *full clones* one button press can start); refs
   within a group run in sequence off the one fetch.
1. Fetch the repository, and compare the resulting `origin/{ref}` head against the
   one recorded last time. Unchanged, and the target is skipped without walking
   anything.
2. Otherwise a local tree walk at that ref, from which each tracked catalogue's
   `remoteSha` is taken. A file deleted upstream keeps its last known sha rather
   than reporting a spurious update. The shas necessarily belong to the head
   recorded beside them, because the fetch just put them there — the REST path had
   to pin the listing to a commit and bypass a cache to get the same guarantee.
3. Open pull requests are refreshed in the same pass — a merge is what the user is
   waiting to see, and a separate button for it would be worse. Shared with
   `refresh_pr_status` through `record_pull`, so the two cannot record different
   things.
4. Everything learned is applied in **one** registry write, matching
   `import_remote_catalogs`. Failures are collected per repository and returned
   rather than aborting the check.

Applying is where the important rule lives. **An update never destroys local work:**

There are two ways in. `pull_catalog` is the one-click path used by the Settings
row menu: it fetches, and if upstream has moved and the local copy has no edits of
its own, it applies immediately and reports `applied` — no dialog, because there is
no decision to make. It returns `needsReview` only when both sides moved, and
`upToDate` or `goneUpstream` otherwise. `apply_catalog_update` is the reviewed path,
called by the diff dialog with the bytes the user looked at. Both go through the same
`install_update`, so the rule below cannot hold in one and not the other.

- Local file **unchanged** → the update is backed up to
  `{decoder_dir}/.wiretap-backups/{stem}.{timestamp}.toml` (a dotted subdirectory,
  so the non-recursive top-level scan never sees it), writes via temp-plus-rename,
  and records the new `syncedSha`.
- Local file **modified** → the backend **refuses**, and the UI routes the update
  into the Catalog editor via `catalogEditorStore::openSuccessRemote`, which loads
  the remote text as the working buffer while pegging the diff baseline to the
  on-disk copy. The update then presents exactly as a schema migration already
  does: a reviewable, saveable diff in `DiffView`, with nothing written until Save.
  **There is no merge UI, deliberately — do not write one.**

The refusal is enforced in Rust, not just in JSX: `apply_catalog_update` re-checks
`LocalState` *and* unconditionally compares the file against the `expectedLocalSha`
the review was based on, so a file edited between opening the review and pressing
Apply is not clobbered. The applied `syncedSha` is derived from the bytes written
rather than taken from the caller, so the stored hash is always the hash of what is on
disk. It also runs the same `vet_catalogue` gate the import path uses — validity plus
the frame cap — because this is the path that feeds the editor tree.

Accepting via the editor saves through the ordinary `save_catalog` path, which knows
nothing about provenance. Rather than hooking that command, `local_state` **derives**
the answer: bytes matching `remoteSha` read as committed. That holds however the file
got there — the editor, a copy in Finder, anything — and it mirrors the "your bytes
landed" rule `remote_state` already applied. `syncedSha` is deliberately left alone,
because publish and `reconcile` both key off it.

The handoff to the editor goes through the panel registry
(`sendUpdateToCatalogEditor` → `openPanel("catalog-editor")`, following
`sendHexDataToCalculator`), not a callback prop — so the option exists wherever the
review was opened from. The editor also offers the review directly in its toolbar when
the open catalogue has an update waiting.

---

## Secret scanning

`secrets.rs`. Reverse-engineering notes carry real secrets — VINs, serial
numbers, MQTT passwords, customer names — and a published secret is public
**permanently**: it must be rotated, not force-pushed away. So findings gate the
publish behind an explicit acknowledgement rather than a warning, and a public
target escalates the confirmation.

A rule table, first match wins, shape matching rather than regex: GitHub/Slack
tokens, AWS keys, PEM private keys, JWTs, `key = "value"` credentials, URLs with
userinfo, VIN-shaped strings.

The credential rule requires the keyword in the **assignment key**, not anywhere
on the line — a catalogue may legitimately say `notes = "token frame"` or name a
signal `Token_Passing_Status`, and a scanner that cries wolf on those is one
people learn to click straight through, which defeats the point. There are tests
asserting exactly that.

---

## Auth

Keychain only. `credentials.rs` provides the service-parameterised core
(`set_secret`/`get_secret`/`delete_secret`); sharing tokens use
`SHARING_SERVICE` (`com.wiredsquare.wiretap.sharing`), **deliberately separate**
from `IO_PROFILE_SERVICE` because that bucket's `delete_all_credentials` sweeps
by field name and would wipe a GitHub token when an unrelated IO profile was
deleted. A test guards against someone "tidying up" the two together.

Sharing tokens are unaffected by the IO-profile namespace rename — this bucket
was created after the rebrand, so it has no legacy name and no drain (see
[session-flow.md § IO-profile secrets](session-flow.md#io-profile-secrets)).

Accounts are keyed `{host}:token`, so GitHub Enterprise drops in with no schema
change. Resolution goes through `auth::stored_token` alone, so alternatives (a
1Password `op://` reference, `GITHUB_TOKEN`, `gh auth token`) can be added later
without touching any call site.

**Scopes:** recommend a classic PAT with `public_repo` (`repo` for private
upstreams). Fine-grained tokens are pinned to named repositories, which cannot
express "fork an upstream I have not forked yet" — they work fine for read-only
import. Say this in the UI rather than letting people discover it via a 403.

**Anonymous import needs no token at all** — that is the low-friction on-ramp and
must keep working with the field empty.

---

## Error taxonomy

`ShareErrorKind` drives UI behaviour:

| Kind | UI response |
|---|---|
| `Auth` | route to account settings; keychain entry is kept, so "token rejected" |
| `Forbidden` | show GitHub's message + the required fine-grained permissions |
| `RateLimited` | reset estimate; nudge to connect an account |
| `NotFound` | check the URL; note a private repo needs an account |
| `Network` | offer Retry — publishing is safe to retry |
| `Api` | show GitHub's message verbatim; theirs are good |
| `UnsupportedHost` | capability message naming the host |
| `Invalid` | bad input, or a response we could not parse |

---

## Safety notes

- **Imported catalogues can transmit.** Catalogues carry `interval_ms`, so a
  stranger's file can define frames that reach a live bus. An imported catalogue
  is **never auto-attached to a session** — import writes a file, full stop — and
  the preview states how many frames declare transmit intervals.
- Validation is a schema check, not a safety check. Do not present it as one.
- `catalog::lcs_diff` is bounded by `MAX_LCS_CELLS`; above it the diff degrades
  to remove-all/add-all rather than allocating an `n × m` table.
- Non-UTF-8 content is rejected outright, not lossily converted — a lossy
  conversion would corrupt the blob-SHA comparison the whole model rests on.

---

## Not built yet

- **SSH transport** — enable git2's `ssh` feature and honour the user's agent and
  `~/.ssh/config`. Now a Cargo feature and a credential callback rather than a whole
  second backend, which is what the retired `PublishBackend` trait existed to allow.
- **Non-GitHub hosts** — the transport is already host-agnostic; what remains is
  `require_supported_host`, and PR/fork support per host. GitLab and Gitea read-only
  import would be nearly free.
- Backup pruning — `.wiretap-backups/` grows without bound, and the second-resolution
  timestamp means two applies in the same second overwrite one backup.
- Clone pruning — a clone is kept per saved repository and never removed, even when
  the last catalogue from it is forgotten.
- Shallow or partial clones for large repositories, if a first browse ever proves
  slow enough to matter. libgit2 has no partial-clone support today.
- Alternative credential sources; a repo manifest carrying
  author/description/licence (the metadata `[meta]` lacks); multi-file atomic
  commits via the git-data API; GitLab/Gitea read-only import; device-flow OAuth.
