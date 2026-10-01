// Generated from the Rust serde types by `npm run gen:types`. Do not edit.

/**
 * Writer capabilities - what a transmit-capable profile supports
 */
export type WriterCapabilities = { can_transmit_can: boolean, can_transmit_serial: boolean, supports_canfd: boolean, supports_extended_id: boolean, supports_rtr: boolean, available_buses: Array<number>, };
