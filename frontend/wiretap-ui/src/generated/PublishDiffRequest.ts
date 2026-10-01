// Generated from the Rust serde types by `npm run gen:types`. Do not edit.

/**
 * What to compare, for the push dialog's diff tab.
 *
 * Everything is named explicitly rather than re-derived. The caller already holds a
 * [`PublishPlan`], and re-deriving would mean the `get_repo` request and the fetch
 * that [`resolve`] does — the exact round trip this command exists to avoid.
 */
export type PublishDiffRequest = { 
/**
 * Local catalogue filename in the decoder directory. The bytes are read from
 * disk, never from the editor buffer, so the comparison is against what a push
 * would actually send.
 */
filename: string, repoUrl: string, targetPath: string, 
/**
 * The branch that would actually be committed to.
 */
branch: string, 
/**
 * What that branch would be created off, when it does not exist yet.
 */
baseBranch: string, };
