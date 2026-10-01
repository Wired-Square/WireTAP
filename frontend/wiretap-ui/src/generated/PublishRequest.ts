// Generated from the Rust serde types by `npm run gen:types`. Do not edit.

export type PublishRequest = { 
/**
 * Local catalogue filename within the decoder directory.
 */
filename: string, 
/**
 * Target repository URL, re-parsed here rather than trusted as an identity.
 */
repoUrl: string, 
/**
 * Defaults to the provenance path, else `catalogs/{filename}`.
 */
targetPath?: string | null, 
/**
 * Branch to commit to. `None` — the default — pushes straight to the base branch,
 * which is the ref this catalogue was pulled from. Naming one creates it off the
 * base instead.
 */
branch?: string | null, commitMessage: string, prTitle?: string, prBody?: string, draft?: boolean, 
/**
 * Open a pull request after pushing. Off by default: the common case is pushing a
 * decoder to a repository you own, where a branch and a PR are ceremony around a
 * one-file change. Deliberately **not** forced when a fork is involved either —
 * pushing to your own fork without opening a PR is a legitimate way to park work.
 */
openPr?: boolean, 
/**
 * Increment `[meta].version` in the committed bytes, and write the bumped file
 * back locally once the push has succeeded.
 *
 * **Off by the serde default while the dialog's checkbox is on**, and that
 * asymmetry is the point: this is the one request field that rewrites a file in
 * the user's decoder directory, so a caller that predates it — or any caller that
 * is not the push dialog — must not do so by omission.
 */
bumpVersion?: boolean, 
/**
 * Acknowledged secret-scan findings, so the confirm step can be explicit.
 */
acceptSecretFindings?: boolean, 
/**
 * Correlates progress events with the dialog that asked.
 */
requestId?: string, };
