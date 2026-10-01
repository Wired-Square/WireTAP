// Generated from the Rust serde types by `npm run gen:types`. Do not edit.

/**
 * One commit, as much of it as a provenance line needs.
 */
export type FileCommit = { 
/**
 * Abbreviated to [`SHORT_SHA_LEN`] — this is shown, never resolved.
 */
sha: string, author: string, 
/**
 * Unix seconds, UTC. Formatted by the frontend, which owns the locale.
 */
timestamp: number, summary: string, };
