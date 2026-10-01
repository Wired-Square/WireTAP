// Generated from the Rust serde types by `npm run gen:types`. Do not edit.

/**
 * A repository the user has chosen to keep, independent of whether any
 * catalogue currently comes from it.
 *
 * Deliberately *not* a flag on [`RepoEntry`]: that list is garbage-collected by
 * [`Registry::forget`] as soon as its last catalogue is forgotten, which would
 * silently drop a repository the user had explicitly saved.
 */
export type SavedRepo = { 
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
