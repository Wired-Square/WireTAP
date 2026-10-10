// Generated from the Rust serde types by `npm run gen:types`. Do not edit.

/**
 * A charted signal: every wire it arrives on unless `protocol` or `bus` names one.
 */
export type HistorySignal = { frameId: number, name: string, protocol?: string, bus?: number, };
