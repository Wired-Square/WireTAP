// Generated from the Rust serde types by `npm run gen:types`. Do not edit.
import type { WindowStats } from "./WindowStats";

/**
 * Oldest first; times in seconds.
 */
export type SeriesWindow = { t: Array<number>, v: Array<number>, stats: WindowStats | null, };
