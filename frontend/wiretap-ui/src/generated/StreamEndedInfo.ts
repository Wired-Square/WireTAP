// Generated from the Rust serde types by `npm run gen:types`. Do not edit.
import type { CaptureKind } from "./CaptureKind";
import type { StreamEndReason } from "./StreamEndReason";

/**
 * Stream-ended info, persisted after session destruction for late-arriving fetches.
 */
export type StreamEndedInfo = { reason: StreamEndReason, capture_available: boolean, capture_id: string | null, capture_kind: CaptureKind | null, count: number, time_range: [number, number] | null, };
