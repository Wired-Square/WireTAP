// Generated from the Rust serde types by `npm run gen:types`. Do not edit.
import type { Draft } from "./Draft";
import type { DraftSignal } from "./DraftSignal";
import type { Protocol } from "./Protocol";

export type DraftPreview = { draft: Draft, defaultFrame: Protocol | null, 
/**
 * Each of `draft`'s frames' signals, as it would be written.
 */
signals: Array<Array<DraftSignal>>, };
