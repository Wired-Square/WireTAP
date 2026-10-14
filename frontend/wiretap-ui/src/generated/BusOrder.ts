// Generated from the Rust serde types by `npm run gen:types`. Do not edit.
import type { BurstTiming } from "./BurstTiming";
import type { CyclePattern } from "./CyclePattern";
import type { IntervalGroup } from "./IntervalGroup";
import type { MuxTiming } from "./MuxTiming";
import type { StartCandidate } from "./StartCandidate";

/**
 * Message order on one bus.
 */
export type BusOrder = { bus: number, frameCount: number, 
/**
 * Best first, by confidence × sequence length.
 */
patterns: Array<CyclePattern>, 
/**
 * By interval.
 */
intervalGroups: Array<IntervalGroup>, 
/**
 * Longest gap before first.
 */
startCandidates: Array<StartCandidate>, 
/**
 * In order of first appearance.
 */
mux: Array<MuxTiming>, 
/**
 * In order of first appearance; never a mux id.
 */
bursts: Array<BurstTiming>, };
