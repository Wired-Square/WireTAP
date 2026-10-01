// Generated from the Rust serde types by `npm run gen:types`. Do not edit.

/**
 * Where a repository's clone is, and how far it has drifted from `origin`.
 */
export type RepoStatus = { repoId: string, 
/**
 * Absolute path to the clone. Derived per call — never stored — so it survives an
 * iOS container UUID change.
 */
clonePath: string, 
/**
 * False when nothing has been cloned yet, so the UI can say "not fetched" rather
 * than showing a path that is not there.
 */
cloned: boolean, branch: string, ahead: number, behind: number, };
