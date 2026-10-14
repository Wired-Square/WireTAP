// Generated from the Rust serde types by `npm run gen:types`. Do not edit.
import type { RankedCandidate } from "./RankedCandidate";

export type RankedHypotheses = { 
/**
 * Best first, at most `MAX_CANDIDATES`.
 */
candidates: Array<RankedCandidate>, 
/**
 * Before the cap.
 */
total: number, };
