// Generated from the Rust serde types by `npm run gen:types`. Do not edit.
import type { BurstDraft } from "./BurstDraft";
import type { ByteNote } from "./ByteNote";
import type { DraftSignal } from "./DraftSignal";
import type { MultiBytePattern } from "./MultiBytePattern";
import type { MuxDraft } from "./MuxDraft";
import type { Protocol } from "./Protocol";

/**
 * What the draft knows of one frame.
 */
export type FrameDraft = { protocol: Protocol, 
/**
 * Bytes.
 */
length: number, 
/**
 * The bus whose Frame Order results the frame takes; `None` takes the
 * lowest bus that has one for it.
 */
bus: number | null, signals: Array<DraftSignal>, 
/**
 * A frame without a mux's; a mux frame's are its cases'.
 */
patterns: Array<MultiBytePattern>, mux: MuxDraft | null, intervalMs: number | null, burst: BurstDraft | null, 
/**
 * Frames per bus, when the frame is seen on more than one.
 */
buses: { [key in number]: number }, notes: Array<ByteNote>, frameId: number, isExtended: boolean, };
