// Generated from the Rust serde types by `npm run gen:types`. Do not edit.
import type { ValueFormat } from "./ValueFormat";

/**
 * How a value computed from a signal's samples reads beside its decoded readout:
 * a `sample` (a min, a max, a cursor reading, a difference of two) and a `mean`.
 */
export type SignalValueFormat = { sample: ValueFormat, mean: ValueFormat, };
