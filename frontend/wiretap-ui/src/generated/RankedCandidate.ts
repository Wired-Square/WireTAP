// Generated from the Rust serde types by `npm run gen:types`. Do not edit.
import type { HypothesisReason } from "./HypothesisReason";
import type { ScaledField } from "./ScaledField";

export type RankedCandidate = { frameId: number, name: string, params: ScaledField, score: number, reasons: Array<HypothesisReason>, };
