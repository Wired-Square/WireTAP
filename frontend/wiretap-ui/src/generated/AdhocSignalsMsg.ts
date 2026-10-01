// Generated from the Rust serde types by `npm run gen:types`. Do not edit.
import type { AdhocValue } from "./AdhocValue";
import type { HeatmapCounts } from "./HeatmapCounts";

/**
 * A Dashboard window's ad-hoc signals for one frame batch.
 */
export type AdhocSignalsMsg = { 
/**
 * Masked ids in first-seen order.
 */
frameIds: Array<number>, values: Array<AdhocValue>, toggles: Array<HeatmapCounts>, };
