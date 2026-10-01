// Generated from the Rust serde types by `npm run gen:types`. Do not edit.

/**
 * A community repository as the frontend lists it.
 *
 * Composed rather than restated, so a field added to [`SavedRepo`] reaches both
 * lists instead of only the saved one. `builtin` is the whole of the difference;
 * a shipped entry carries an empty `savedAt`, which is what the properties panel
 * keys its date row off.
 */
export type CommunityRepoView = { 
/**
 * Ships with WireTAP, so it cannot be edited or removed.
 */
builtin: boolean, clonePath: string, cloned: boolean, 
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
