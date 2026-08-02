# Catalogue Sharing over Git

How WireTAP pulls decoder catalogues from a repository someone shared, and pushes
yours back. This is the canonical reference for `src-tauri/src/catalog_share/`.

For how catalogues are loaded, cached and watched locally, see
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
`read_blob`, `blob_sha`, `branches`, `known_refs`, `has_branch`, `path_at_ref`,
`ahead_behind` — resolves from `refs/remotes/origin/{ref}` in the object database, so
`align_branch` moves the ref and stops there. Checking out on every sync meant a
whole-tree diff, and on a branch switch a rewrite of every file, for work that was
then thrown away.

Two of those exist to avoid work rather than to answer a new question. `blob_sha`
returns the tree entry id without loading the object, because a "have these bytes
changed?" verdict does not need an inflate plus two full-size allocations.
`branches` is branch names only, unlike `known_refs`, which folds tags in — a tag
resolves to a commit but can never be a push target, and answering "yes" for one
produced a plan the push path had to reject.

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
| `catalog_share/registry.rs` | Provenance registry: entries, blob SHAs, sync state, saved and community repositories |
| `catalog_share/community.rs` | The community list — the repositories that ship with WireTAP, plus the user's own additions |
| `catalog_share/publish.rs` | The publish step machine: resolve, fork if needed, commit, push, optional PR |
| `catalog_share/secrets.rs` | Pre-publish credential scan |
| `catalog_share/auth.rs` | Keychain token resolution and the account commands |
| `catalog_share/error.rs` | `ShareError` / `ShareErrorKind` — the module's error type |

Frontend: `src/api/catalogShare.ts` (wrappers + TS mirrors),
`src/stores/catalogShareStore.ts`, `src/apps/catalog/dialogs/publish/` (the tabbed
push dialog — shell, one file per tab, plus the pure `publishBlockers`/`publishTabs`
derivations), `src/apps/catalog/dialogs/{GitHubToken,CreateCatalogRepo,CatalogUpdate}Dialog.tsx`,
`src/apps/catalog/components/CatalogShareDialogs.tsx` (those four, which
interlink, shared by the Catalog editor and Settings → Catalogs), and
`src/dialogs/catalog-share/RepositoryDialog.tsx` — mounted by whoever offers the
button (the shared catalogue picker, and Settings → Catalogs), because unlike the
other four it hands off to none of them. Also
`src/components/catalogIcons.ts` — the icon vocabulary (see below) — with
`src/components/catalogSyncPresentation.tsx` rendering its status table for the
catalogue picker and Settings → Catalogs, and
`src/hooks/useCatalogSources.ts` — the catalogue list joined with **all** of a file's
provenance rows (`joinCatalogSources`, pure and separately tested, because a
one-to-one map kept whichever subscription came last; `sourcesFor` is the same
question for a surface that has only one file, and `filenameKey` is the one owner of
the case fold on this side of the wire), both reconciled off the same
`CatalogListChanged` push via the shared `src/hooks/useWsResync.ts` primitive (also
used by `useCatalogList`, `useOpenAppsSync` and `useSessionRosterSync`).

---

## The sync-state model

The load-bearing idea. For every **subscription** — one local file against one
repository — the registry stores the **git blob SHA-1 of the exact bytes last
exchanged with that remote** — `sha1("blob {len}\0" + bytes)`, which is what
`git hash-object` computes and what GitHub returns in its trees and contents
responses. One stored value therefore answers both questions, and the local one
needs **no network call**:

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

**A local file may hold several subscriptions**, one per repository, each with its
own `syncedSha`. That is not an edge case: a decoder pushed to your fork and also
tracked against the upstream it came from has genuinely exchanged different bytes
with each, and the two answers must not be averaged into one. The table above stays
per subscription; folding them into the single label every list wants is the next
section.

Distinct from all of the above is *"has my work landed upstream?"* — a merged PR.
That is tracked separately (`PublishState.pr_number` + `refresh_pr_status`),
because pushed and merged are different things and for collaboration the
difference is what people want to see.

---

### One status for the UI

The two states above are orthogonal and both are needed to be honest about what is
knowable without a network call. Every surface that lists catalogues wants a single
label, so `SyncStatus::collapse` in `registry.rs` collapses them **exactly once, in
Rust**, and every consumer reads that one field.

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
`collapse` matches on the `(LocalState, RemoteState)` tuple with **no `_` arm**, so
adding a variant to either input is a compile error rather than a silently wrong label.

### Folding several repositories into that one label

A file with several subscriptions has several of those pairs. `aggregate_status`
folds the **two inputs** across them and then calls `collapse` **once**, so there is
still exactly one function that turns a pair of states into a label. The rejected
alternative is ranking the seven labels: that would be a second model of `collapse`'s
own arm order, and two rankings maintained by hand drift.

One rule, in both directions: **a known, actionable answer outranks an unknown one,
which outranks a known nothing-to-do.**

```rust
LocalState:  Missing > Modified > Committed > Untracked
RemoteState: Diverged > UpstreamAhead > Unknown > InSync
```

`UpstreamAhead > Unknown` is the load-bearing half — a repository with a real,
pullable update must not be hidden behind one nobody has checked — and
`Unknown > InSync` is its mirror, so an unverified claim of currency is never
laundered into a verified one. Both ranks are exhaustive matches with no `_` arm, for
the same reason `collapse` is.

The fold is the **identity** for a single subscription, over every reachable
combination of the three shas — that is what makes it a generalisation rather than a
second answer, and `the_aggregate_is_the_single_subscription_over_every_combination`
pins it rather than this paragraph.

`localOnly` is now precisely the zero-subscription case, which is what
`CatalogFile.trackedRepoCount` reports as `0`.

**Why Rust rather than the frontend.** The status rides on `CatalogFile` (from
`list_catalogs`) as well as `TrackedCatalog`, so the catalogue picker can draw it
without importing the sharing store — that picker is mounted by five panels that
otherwise never touch it, and a frontend join would have put the whole share subtree
in all five bundles. Doubly true now: the frontend cannot fold what it cannot see.
It is also nearly free where it is computed: `scan_catalogs`
already reads every `.toml` in full to extract its `[meta].name`, so the status costs
one SHA-1 over bytes already in memory. `CatalogEntry::sync_status_of` is **pure** —
it takes an already-computed blob SHA and touches no disk — which is what lets the
scan label a row without re-reading the file it just read.

`CatalogFile` carries `trackedRepoCount` and **not** the per-repository list. Note the
bundle argument does *not* apply to the list — `src/api/catalog.ts` imports
`CatalogSyncStatus` as a type-only import, erased at build, and a `TrackedCatalog[]`
field would erase the same way. The reasons are different and still decisive:
`scan_catalogs` would need repository *labels*, coupling the directory scan to a table
it deliberately does not know about; it would duplicate `list_catalog_sources`'
projection into the command every panel calls; and it would put N objects on the wire
for five panels that render one glyph. The count needs no lookup at all — it is a
`Vec::len()` already in hand — and it is what makes a summary glyph legible, since a
glyph giving no sign it is summarising is the dishonest part.

`TrackedCatalog` is one row **per subscription**, and deliberately ships the collapse
and **not** its two inputs. Sending `localState` and `remoteState` alongside it is an
invitation to re-derive rather than ask, which is the drift the single collapse exists
to prevent — and it had already happened twice before they were removed. Settings
renders the aggregate badge *and* the per-repository badges it was folded from on one
card, so the fold is derivable by eye rather than taken on trust.

The rule that a one-click pull never runs over local edits is enforced in **Rust**,
twice — `CatalogEntry::remote_state_of` weighs the local state and returns `Diverged`
rather than `UpstreamAhead`, and `pull_catalog` refuses again before writing.
`remote_state_of` derives the local state from the same SHA rather than taking it as a
parameter, so a caller cannot pass an inconsistent pair.

`src/utils/catalogSync.ts` keeps only `hasLocalChanges` / `hasRemoteChanges` —
predicates *over* the status that answer a UI question ("is Push worth offering?").
Presentation lives in `src/components/catalogSyncPresentation.tsx`, over the
`SYNC_STATUS_DRESS` record in `catalogIcons.ts`: one row per status carrying its icon,
glyph colour and pill class, rendered as `CatalogSyncIcon` (the picker's glyph) and
`CatalogSyncBadge` (the settings row, which shows the glyph *and* the label so one
surface teaches the other). The two stay separate components — a fast selector is not a
management list — but they cannot dress the same status differently.

### The icon vocabulary

`src/components/catalogIcons.ts` owns every glyph the journey uses, on one rule:

> **One family per axis.** A glyph answers either *where things stand* or *what this
> button does*, never both.

- **State is a noun → arrows.** `↑` local ahead, `↓` remote ahead, `↕` diverged. They
  are literally what "ahead" and "behind" mean, and they match the labels' own words.
- **Transfer is a verb → clouds.** `CloudUpload` push, `CloudDownload` pull *and*
  apply-an-update, so one idea reads as one glyph from the status through to the button
  that resolves it. `RefreshCw` means only "check for updates" — a poll that writes
  nothing.
- **Repository objects → git marks.** `FolderGit2` is a repository, `GitBranch` is only
  ever a branch or ref, `FolderOpen` reveals the clone.
- **Provenance is a chain link.** `Link` adopts an upstream file, `Unlink` (as
  `Forget`) stops tracking one. Deliberately not clouds: neither moves a byte, and the
  two are exact inverses, so they wear inverse glyphs.
- **One alert glyph.** Severity is carried by tone, so `src/components/Alert.tsx` owns
  `TriangleAlert` and takes no `icon` prop — a per-caller glyph is exactly how this
  journey accumulated four of them for one job. `SecretFindings` keeps `ShieldAlert` as
  the single deliberate exception: a security finding is a section, not an alert box.

**Why a file rather than a convention.** The rule exists because it was broken: the
"Local ahead" status and the "Push" action were the *same component*. lucide re-exports
`UploadCloud` as an alias of `CloudUpload`, so two different names produced one picture
— invisible to grep, invisible to the compiler, total on screen. `src/tests/catalogIcons.test.ts`
asserts no two names resolve to one glyph and that no state wears a transfer glyph; it
is the only check that can see through a lucide alias.

Import through the vocabulary (`import * as ShareIcon from ".../catalogIcons"`), not
from lucide directly. The exports are deliberately *not* tree-shaken — the file records
the measurement and the trade.

### Keeping the cached status fresh

`list_catalogs` serves from `CatalogCache`, which is rebuilt by the decoder-directory
watcher and by save/import/rename/delete. But a **registry** write changes a status
without touching a single file, and no filesystem event will ever fire for it. Those
paths therefore rebuild the cache explicitly, via `write_and_refresh` in `mod.rs` —
or `write_then_refresh`, its sibling for a write that always changes something and has
a value to hand back (the two that create a subscription):

| Command | What moves | Why nothing else catches it |
|---|---|---|
| `check_catalog_updates` | `remote_sha` | the command that turns `unchecked` into a real answer |
| `pull_catalog` | `remote_sha` | on the decline paths; the applied path refreshes via `install_update` |
| `forget_catalog_source` | entry removed | the row loses one repository, or becomes `localOnly` |
| `link_catalog_source` | entry created | adopting an upstream file writes no file at all |

| `persist_publish_state` | `synced_sha`, and the entry itself | a push flips `localAhead` → `inSync`, or creates the subscription outright |
| `list_catalog_sources` | `local_filename` | a relink moves every subscription of the renamed file |

The last one is the delicate one. `refresh_catalog_cache` broadcasts
`CatalogListChanged`, which the frontend answers by calling `list_catalog_sources`
again — so refreshing unconditionally there would loop across the IPC boundary. It is
gated on `reconcile` reporting a relink, and `reconcile` is a fixed point after one
application (its relink target came from the present-files list, so the next pass finds
nothing missing). Relinking a filename *group* atomically is what keeps that argument
whole: relinking one subscription while a sibling stayed missing would leave something
for the next pass to find, and the loop would not terminate. That argument is pinned by
`reconcile_is_a_fixed_point`, not left to this paragraph.

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
  // Community repositories the user added, same shape as savedRepos. The ones
  // that ship with WireTAP are compiled in and never written here.
  "communityRepos": [{ "id": "gh:someone/shared", "url": "…", "owner": "…", "repo": "…", "savedAt": "…" }],
  "repos": [{
    "id": "gh:owner/repo",            // host-derived, so GHE/GitLab cannot collide
    "host": "github.com", "owner": "…", "repo": "…",
    "defaultBranch": "main",
    "fork": { "owner": "…", "repo": "…" },   // set by publish; read before re-probing
    // Head commit per ref, so a repo tracked at two refs keeps two records —
    // one shared field would be overwritten by whichever ref was checked last.
    "headCommits": [{ "gitRef": "main", "commit": "…" }]
  }],
  // One entry per **subscription**: a local file against one repository. Several may
  // share a `localFilename` — a decoder tracked against a fork and its upstream — each
  // with its own `syncedSha`. Both `id` and `(localFilename, repoId)` are unique, and
  // `upsert_catalog` is the one place either is enforced.
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

Saved repositories are the one part of this file the user typed, so the five
commands that mutate the two curated lists go through `write_checked` and
**report a failed write** — unlike the provenance paths, which log and continue
because a lost `syncedSha` is re-derived on the next browse. `set_favourite_repo`
likewise reports a refused id rather than ignoring it, because the UI stars
optimistically and needs the error to roll back.

`communityRepos` is the same shape but a different job: other people's
repositories, browsed and imported from and never a publish target — which is why
they are a second list rather than a flag, and why nothing there can be starred.
The entries that ship with WireTAP live in `community::BUILTIN` and are merged in
at listing time rather than seeded on first run: seeding would leave a copy in
every existing install, so retiring a shipped repository would never actually
retire it. `save_community_repo` and `forget_community_repo` refuse a built-in id
for the same reason — but `forget` refuses only after trying the removal, so an
entry a user added before we shipped that repository can still be deleted rather
than stranded in a file it no longer appears in.

Which list a repository is in is what makes it a publish target: `RepoPicker`
offers `savedRepos` and `set_favourite_repo` refuses an id absent from it, so
"community is never published to" is a backend rule rather than a UI habit. The
same split is why the "Mine" tab and the star exist at all.

Keyed on **filename**, not absolute path: the decoder dir is a user setting
(`handle_decoder_dir_change`) and iOS container UUIDs go stale
(`paths_are_stale`). Resolved as `decoder_dir.join(localFilename)`.

**Do not hand-roll entry lookup.** `registry::filename_eq` owns the
case-insensitivity rule (macOS is case-insensitive); go through `catalog_for`
(filename **and** repository), `catalog_for_remote`, or the `_by_id` pair. A publish
path that misses its entry silently opens a *rival* pull request against a fresh path
instead of adding a commit to the existing one.

The unscoped filename lookup was **deleted, not deprecated**. With several
subscriptions per file it would return an arbitrary repository's entry, which is
precisely how that rival pull request gets opened — so the mistake is now not
expressible rather than merely discouraged.

### Following renames — three layers, each covering what the previous cannot

1. **In-app rename** → `catalog.rs::rename_catalog` calls
   `registry::on_catalog_renamed`, which moves **every** subscription to that
   filename. This is the only layer that can follow a rename of a *modified* file,
   because `syncedSha` describes the last-exchanged bytes rather than what is on disk.
2. **Out-of-app rename** → `Registry::reconcile` matches by content hash, per
   filename **group** rather than per entry: two subscriptions to one file hold
   legitimately different `syncedSha`s, so a per-entry loop relinked whichever
   happened to match the disk and orphaned its sibling as permanently missing. The
   group relinks as a unit, on any of its shas. Hashing is lazy: with every tracked
   file present, nothing is read beyond the directory listing.
3. **Neither worked** → the entry reports `LocalState::Missing` and the user can
   forget it.

`reconcile` refuses to guess in **both** directions. Several candidate files for one
group is the original rule. Several groups wanting one file is the new one, and it is
load-bearing: without it both would take that file, leaving two subscriptions to one
repository for one filename — the pair `upsert_catalog` exists to prevent, after which
`catalog_for` is ambiguous again. It also makes the outcome independent of the order
`catalogs` happens to be in.

In-app **delete** forgets every subscription to that file outright (explicit intent);
an out-of-app delete leaves them reporting missing. `duplicate_catalog` deliberately
does *not* copy provenance — two local files claiming one upstream path would make
publishing ambiguous, and that pair is now refused by `upsert_catalog` rather than
merely avoided here.

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

// Community repositories — community.rs. Same idea, second list; a shipped entry
// is refused by both, since it is not the user's to change. Every row is a
// CommunityRepoView: a SavedRepoView plus `builtin`, with an empty `savedAt` on a
// shipped entry — it was never added, and that is what the UI hides its date on.
save_community_repo(app, input, label?, gitRef?, directory?) -> CommunityReposView
forget_community_repo(app, repoId) -> CommunityReposView

// Tracked sources — mod.rs
list_catalog_sources(app) -> CatalogSourcesView          // includes LocalState
link_catalog_source(app, filename, repoUrl, remotePath, gitRef?) -> TrackedCatalog
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
publish_diff(app, req: PublishDiffRequest) -> PublishDiff // no network at all
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

## Linking: adopting what is already upstream

`link_catalog_source` records a subscription without pushing anything. It exists
because the journey had a dead end: a catalogue nothing had ever tracked, whose bytes
upstream already matched — pushed before publishing recorded provenance, or copied in
by hand — could not be pushed, since an unchanged tree is refused all the way down in
`push_blocking`. The only action that could have created the tracking was the one
being refused.

`synced_sha` takes the **remote** blob sha, not the local one. Nothing was exchanged,
so neither is literally true — but that pair of hashes is what makes both outcomes
read honestly with no new state:

| Local file vs upstream | Reads as | Why that is right |
|---|---|---|
| identical | `inSync` | it is; and the dead end is gone |
| differs | `localAhead` | there really is something to push now |

It refuses when the path is not on the ref (there is nothing to adopt — that is a
push) and when the file is already tracked against that repository. The URL is parsed
in Rust, never taken from the frontend, for the same reason publishing does it: this
decides which repository a file is bound to. It fetches before reading the sha, so
what is recorded is what upstream holds now rather than whatever a previous browse
happened to see.

The push dialog offers **Link** whenever the chosen repository already holds the file
and does not yet track it — `PublishPlan.baseBlobSha` is exactly that question, and
the plan always answers it, so no Changes tab need be opened. Deliberately not the
Changes tab's `exists`, which is about the *chosen* branch: a pull-request branch is
not what a subscription would record.

---

## Publish

### Branches and pull requests are optional

The default is a direct commit to the base branch: no branch created, no pull
request opened. Most publishing is a decoder going back to a repository the user
owns, where a branch and a PR are ceremony around a one-file change.

`PublishRequest` carries exactly two knobs about *where* the commit goes, replacing
the three overlapping ones (`mode`, `commit_to_base`, `branch`) the REST design needed:

- `branch: Option<String>` — `None` pushes to the base branch; naming one creates
  it off the base.
- `open_pr: bool` — off by default, and **never forced**, not even when a fork is
  involved: pushing to your own fork and stopping is a legitimate way to park work.

One further knob is about *what* is committed — `bump_version: bool`, see
[§ Version bumps](#version-bumps). It is **off by the serde default while the dialog's
checkbox is on**, and that asymmetry is deliberate: it is the only request field that
rewrites a file in the user's decoder directory, so a caller that predates it, or any
caller that is not the push dialog, must not do so by omission.

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
4. **Commit and push** — the bytes committed are the saved file, plus a
   `[meta].version` increment when one was asked for **and** the push would change the
   file anyway ([§ Version bumps](#version-bumps)). `git::commit_and_push` then syncs
   the clone, creates the branch off `origin/{base}` if it does not exist, writes the
   file into the working tree, stages, commits and pushes. When a fork is the target it
   pushes to an **anonymous remote** so a renamed or deleted fork cannot leave a stale
   entry in the user's `git remote -v`.

   libgit2 reports a server-side rejection through the `push_update_reference`
   callback and **still returns `Ok`** from `push`, so that callback is the only
   way to tell a rejected push from a successful one. It is checked.
5. **Pull request**, when asked for — look before you leap: the push just updated
   any open PR on the branch, so creating a second would be wrong. `find_open_pull`
   filters on **`base` as well as `head`**, because the base now varies with a
   catalogue's provenance and an open PR against a different base is not this one.
6. **Persist** — the pushed blob sha becomes `synced_sha`, so the file immediately
   reads as in sync; and the **subscription is created** — along with the `RepoEntry`
   — when this push is the first thing to link the file to that repository. That was
   a real bug: `persist_publish_state` only ever *updated*, silently doing nothing for
   a catalogue no import had tracked, so a successful push left the picker showing
   `localOnly` for ever. `RepoEntry` was likewise only ever born of a browse, so a
   push to a saved-but-never-browsed repository had nothing to record its fork on.

   The subscription records the **base branch**, not the branch pushed to. A
   pull-request branch is ephemeral and may exist only on the user's fork, so it is
   not on `refs/remotes/origin/{ref}` of the upstream clone the update check reads —
   an entry naming one would never see an update again. `resolve` also reads
   `git_ref` back as the *next* publish's base, which would then trip the "a pull
   request needs its own branch" refusal. The branch is already recorded in
   `PublishState.branch`, where the next publish reuses it while its PR is open and
   unmerged, so a second edit adds a commit to the review under way instead of opening
   a rival PR the branch-keyed lookup would never find; a copy in `git_ref` would be
   the lower-authority one.

   A corollary: publishing a catalogue pinned to a **tag** re-points its subscription
   to the branch the commit landed on. Only a branch can be a push target, and
   `synced_sha` must describe a ref we can read back — previously the tag survived
   while `synced_sha` silently began describing a different ref, which is worse.

   An open pull request survives a push that did not ask for one. Overwriting
   `PublishState` wholesale dropped `pr_number`, after which `open_pulls` stopped
   polling and the merge — the thing the user is waiting to see — was never noticed.

   A version bump reaches the local file **here**, between the push and this write, and
   only when the file still hashes to the bytes it was derived from — see
   [§ Version bumps](#version-bumps) for why that ordering and that guard.

An **unchanged tree is refused** at step 4, in `push_blocking`, where both the new
tree id and the parent's are already in hand. Committing bytes that are already there
would push a commit saying nothing and report success for a no-op. The dialog warns
first, but the invariant belongs where commits are made: the dialog can only warn
about a branch it has diffed against.

**A version bump does not retire that refusal**, and keeping it alive is why the bump
is withheld when the parent already holds these bytes. Bump unconditionally and the
tree always differs by one line, so the refusal could never fire again — a no-op push
would silently become a commit whose entire diff is a version number.

### Version bumps

`[meta].version` is the author's revision counter. Nothing decodes on it: it is read in
exactly two places — the parser, which stores it and never consults it again, and a
`>= 1` floor in validation. `migrate.rs` does not mention it at all, because migration
is shape-driven and does not stamp a version. So incrementing it is safe, and the only
question is when.

The push dialog offers it, **on by default**, because publishing to a repository other
people pull from is the moment the number matters most and is easiest to forget. A
local save never bumps.

Two rules, neither obvious from any one call site:

- **A bump alone is not a pushable change.** `bump_applies` withholds it when the push
  parent already holds these bytes, which is what leaves the unchanged-tree refusal
  above able to fire. The comparison uses `git::blob_sha_at_push_parent`, which resolves
  the same parent `push_blocking` commits onto — `refs/heads/{branch}` when it exists,
  else `origin/{base}` — because two answers to "would this push change anything?" would
  eventually disagree, and the case where they would is real: `git::sync` aligns only
  the repository *default* branch.
- **A failed push leaves the local file untouched.** The bumped bytes go to disk only
  after the push succeeds, guarded by the same unconditional hash compare
  `apply_catalog_update` makes, so a catalogue edited while the push was in flight is
  left entirely alone. A refused write costs a version number; clobbering costs work.
  `synced_sha` is the pushed blob sha in **both** outcomes — that is what was exchanged
  — so a refused write reads as `localAhead`, which is honest: those local edits really
  are not upstream.

The increment itself is a **byte splice over the integer's own span**, in
`wiretap_catalog::edit::bump_meta_version`, deliberately *not* an `EditOp`. Every op
round-trips a `toml_edit::DocumentMut`, which re-formats the key it replaces (taking the
comment block above it, which the parser folds into that key's decor), drops a trailing
comment on the value, and re-emits every line with a bare `\n` — so a CRLF catalogue
comes back rewritten end to end. This path hashes exact bytes, so all three would turn a
one-line bump into a whole-file diff. That is measured against `SetTable`, not assumed,
and pinned by tests that assert whole documents rather than `contains`.

An absent `version` key is written as `2`: absent and `= 1` are the same claim, so 2 is
the honest increment for a file whose author never wrote the key.

**The editor.** Nothing tells the Catalog editor a file changed underneath it, so a
buffer left holding the old number would write it straight back on the next save. A
clean buffer therefore **adopts** the bump silently (`adoptOnDiskChange`) — it and disk
were identical a moment ago, so adopting is the definition of staying clean. A dirty
buffer is never touched; instead the checkbox is **disabled**, because the push carries
the *saved* bytes and renumbering a file that is not what the user is looking at is
worse than not renumbering it. The editor's own Push is already blocked while dirty, so
that case only arises publishing from Settings → Catalogs.

### Reviewing the change before pushing

`publish_diff` answers "what would this push change upstream?" and is what the push
dialog's **Changes** tab renders. It touches **no network**: preflight has already
fetched the clone, so this parses the URL and reads the object database. It
deliberately does not call `resolve` — that does a `get_repo` request and a fetch,
the exact round trip it exists to avoid — and it does not build a `GitHubClient`
either, because doing so reads the keychain, which is synchronous OS IPC, once per
debounced keystroke.

It compares the **unbumped** saved file, and that is deliberate: the same call answers
`identical`, which drives the "nothing to push" blocker, so folding a pending version
bump into the rows would make an otherwise-identical file claim a change. The tab names
the bump in a line instead — and the *absence* of that line when the tab says identical
is the visible form of "a bump alone is not a pushable change".

`git::path_at_ref` answers it in one `Repository::open`: it resolves the branch the
push would land on (falling back to the base branch when that branch does not exist
yet, which is the honest baseline for a branch about to be created), reads the blob,
and walks first-parent history for the commit that last touched the path — sharing
the resolved ref and the tree entry across all three. The walk is skipped entirely
when the path is not on that ref, which is the common case for a first push.

The diff itself is computed in Rust by `catalog::diff_lines` — the same LCS the
editor's diff view uses — and `PublishDiff` carries the **rendered rows**, not the two
texts. Returning the texts would ship both files to the frontend and straight back
over the WebSocket to be diffed by the function that was one call away. Rows are
skipped altogether when the two blobs hash the same: the tab says so in one line
rather than rendering a whole catalogue of unchanged context.

`PublishPlan` also carries `branches` (the clone's real branch names, so the branch
field offers suggestions without a `matching-refs` request), `localBlobSha` and
`baseBlobSha` — the last two so the dialog can say "nothing to push" for the default
direct push without asking for any file text. Those three are filled by
`enrich_for_dialog`, which only the preflight runs: `resolve` is shared with the
publish path, and that path reads none of them.

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

- **The editor does not notice a file changing underneath it.** Nothing routes a
  decoder-directory change to the Catalog editor's buffer — the watcher and
  `CatalogListChanged` reach the picker only. A publish version bump works around it by
  calling `adoptOnDiskChange` directly, and `pull_catalog` applying an update has the
  same gap today. The general fix is a watcher-driven reconcile against the buffer, with
  a decision about what a *dirty* buffer should be offered; it should be designed for
  that whole problem rather than bolted onto this one.
- **Honest status after a push to a fork or a pull-request branch.**
  `mark_exchanged` sets `remote_sha = synced_sha`, so the row reads `inSync` — but a
  push to `catalog/x` on a fork means the upstream base branch does *not* hold those
  bytes, and Settings now shows that claim beside a "PR #42 open" chip saying the
  opposite. The naive fix is worse: leaving `remote_sha` alone makes the row read
  `remoteAhead` and offer a one-click pull that reverts the user's own work. An honest
  answer needs a third state — *these bytes are on a branch awaiting review* — that the
  two-SHA model cannot express. The fold is at least robust to it: `InSync` is the
  weakest remote rank, so it can never mask another repository's real state.
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
