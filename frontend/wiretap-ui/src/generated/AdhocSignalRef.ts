// Generated from the Rust serde types by `npm run gen:types`. Do not edit.
import type { ScaledField } from "./ScaledField";

/**
 * One charted signal, as the Dashboard names it. `params` is a `hyp_*` name's
 * saved scaling; every other name is parsed.
 */
export type AdhocSignalRef = { frameId: number, name: string, params?: ScaledField, };
