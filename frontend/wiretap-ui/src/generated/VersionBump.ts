// Generated from the Rust serde types by `npm run gen:types`. Do not edit.

/**
 * What a version bump did, when one was applied.
 *
 * One struct rather than three fields on [`PublishResult`], so "from", "to" and
 * "did it reach the disk" cannot be reported apart.
 */
export type VersionBump = { from: number, to: number, 
/**
 * False when the local file changed while the push was in flight, so the bumped
 * bytes are upstream but not on disk. The catalogue then reads as locally ahead,
 * which is honest — those local edits really are not upstream.
 */
writtenLocally: boolean, };
