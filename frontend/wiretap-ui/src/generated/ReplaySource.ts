// Generated from the Rust serde types by `npm run gen:types`. Do not edit.

/**
 * The frames a replay plays: `count` from `offset` in a capture, CAN only,
 * every one on `bus` when it is set.
 */
export type ReplaySource = { capture_id: string, offset: number, count: number, bus?: number | null, };
