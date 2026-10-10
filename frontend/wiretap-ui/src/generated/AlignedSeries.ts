// Generated from the Rust serde types by `npm run gen:types`. Do not edit.
import type { WindowStats } from "./WindowStats";

/**
 * A chart's data: `x` in seconds, a `y` column and stats per signal.
 */
export type AlignedSeries = { x: Array<number>, y: Array<Array<number | null>>, stats: Array<WindowStats | null>, };
