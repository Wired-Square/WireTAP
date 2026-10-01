// Generated from the Rust serde types by `npm run gen:types`. Do not edit.

/**
 * Stream-ended info, persisted after session destruction for late-arriving fetches.
 */
export type StreamEndedInfo = { reason: string, capture_available: boolean, capture_id: string | null, capture_kind: string | null, count: number, time_range: [number, number] | null, };
