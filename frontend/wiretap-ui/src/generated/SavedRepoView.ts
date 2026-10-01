// Generated from the Rust serde types by `npm run gen:types`. Do not edit.

/**
 * A saved repository plus where its clone is, so the list answers "is this one
 * fetched, and where does it live?" without a call per row.
 *
 * Derived here rather than stored on [`SavedRepo`]: the clone path must never be
 * persisted (see `git::repos_root`), and a saved repository has no clone at all
 * until it is first browsed.
 */
export type SavedRepoView = { clonePath: string, cloned: boolean, 
/**
 * Stable key from `CatalogSource::repo_id()` — same identity as `RepoEntry`.
 */
id: string, 
/**
 * Canonical repository URL. Fed verbatim to `PublishRequest::repo_url`, which
 * re-parses it, so the frontend never hands the backend a bare identity.
 */
url: string, owner: string, repo: string, 
/**
 * Display name; falls back to `{owner}/{repo}` when unset.
 */
label?: string, 
/**
 * Ref to browse and import from. **Not** the publish branch — see
 * `PublishRequest::branch`, which names a branch to create.
 */
gitRef?: string, 
/**
 * Repo-relative directory holding catalogues, e.g. `catalogs`.
 */
directory?: string, savedAt: string, };
