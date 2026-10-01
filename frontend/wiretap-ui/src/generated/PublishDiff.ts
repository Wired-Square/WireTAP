// Generated from the Rust serde types by `npm run gen:types`. Do not edit.
import type { DiffLine } from "./DiffLine";
import type { FileCommit } from "./FileCommit";

/**
 * What a push would change upstream, ready to render.
 *
 * Carries the rendered diff rather than the two texts. Both are already in hand here,
 * and the diff is the same crate's `catalog::diff_lines` — returning the texts instead
 * would ship them to the frontend and straight back over the WebSocket to be diffed by
 * the function that was one call away.
 */
export type PublishDiff = { 
/**
 * The ref actually read. Echoed so the tab can label the comparison honestly when
 * it fell back from a branch that does not exist yet.
 */
comparedRef: string, branchExists: boolean, targetPath: string, 
/**
 * Unified diff rows, upstream → local, so an `add` is what this push would add.
 * Empty when `identical`, which the tab renders as a banner rather than a page of
 * unchanged lines.
 */
lines: Array<DiffLine>, added: number, removed: number, 
/**
 * False when this push would add the file rather than change it.
 */
exists: boolean, 
/**
 * Byte-identical, so the commit would be empty.
 */
identical: boolean, 
/**
 * Upstream has moved on from the `synced_sha` this catalogue was imported at, so
 * pushing replaces a change that was never pulled.
 */
upstreamMoved: boolean, 
/**
 * The last upstream commit to touch this path. `None` when it is not upstream yet
 * or the walk found nothing within its bound.
 */
lastChange: FileCommit | null, };
