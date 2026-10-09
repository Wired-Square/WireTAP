// Generated from the Rust serde types by `npm run gen:types`. Do not edit.
import type { BurstTiming } from "./BurstTiming";
import type { CyclePattern } from "./CyclePattern";
import type { IntervalGroup } from "./IntervalGroup";
import type { MuxTiming } from "./MuxTiming";
import type { StartCandidate } from "./StartCandidate";

export type BusOrder = { bus: number, frameCount: number, patterns: Array<CyclePattern>, intervalGroups: Array<IntervalGroup>, startCandidates: Array<StartCandidate>, mux: Array<MuxTiming>, bursts: Array<BurstTiming>, };
