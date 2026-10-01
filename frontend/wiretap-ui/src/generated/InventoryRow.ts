// Generated from the Rust serde types by `npm run gen:types`. Do not edit.

/**
 * One frame identity in a source, with its rollup.
 *
 * Identity is (protocol, frame_id, is_extended): CAN `0x100` and Modbus
 * register 256 are different frames that happen to share a number, and a
 * standard id is not its extended namesake. This is the shape every source
 * reports, and the one the MCP `frame_inventory` tool serialises.
 */
export type InventoryRow = { protocol: string, frame_id: number, frame_id_hex: string, is_extended: boolean, count: number, first_us: number, last_us: number, max_dlc: number, };
