// Generated from the Rust serde types by `npm run gen:types`. Do not edit.
import type { BurstFlag } from "./BurstFlag";

export type BurstTiming = { framesPerBurst: number, burstPeriodMs: number, interMessageMs: number, lengths: Array<number>, flags: Array<BurstFlag>, frameId: number, isExtended: boolean, };
