// Generated from the Rust serde types by `npm run gen:types`. Do not edit.
import type { BurstDraft } from "./BurstDraft";
import type { ByteNote } from "./ByteNote";
import type { CatalogProtocol } from "./CatalogProtocol";
import type { DraftSignal } from "./DraftSignal";
import type { MultiBytePattern } from "./MultiBytePattern";
import type { MuxDraft } from "./MuxDraft";

export type FrameDraft = { protocol: CatalogProtocol, length: number, bus: number | null, signals: Array<DraftSignal>, patterns: Array<MultiBytePattern>, mux: MuxDraft | null, intervalMs: number | null, burst: BurstDraft | null, buses: { [key in number]: number }, notes: Array<ByteNote>, frameId: number, isExtended: boolean, };
