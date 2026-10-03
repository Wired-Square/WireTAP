// Generated from the Rust serde types by `npm run gen:types`. Do not edit.
import type { BusErrorState } from "./BusErrorState";

export type BusStatus = { 
/**
 * The session's bus, after mapping.
 */
bus: number, state: BusErrorState, no_ack: boolean, tx_errors: number | null, rx_errors: number | null, };
