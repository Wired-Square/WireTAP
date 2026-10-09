// Generated from the Rust serde types by `npm run gen:types`. Do not edit.
import type { MuxSelector } from "./MuxSelector";

export type MuxTiming = { muxPeriodMs: number | null, interMessageMs: number, frameId: number, isExtended: boolean, selector: MuxSelector, occurrences: { [key in number]: number }, };
