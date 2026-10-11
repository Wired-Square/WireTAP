// Generated from the Rust serde types by `npm run gen:types`. Do not edit.

/**
 * A network node/peer declared under `[node.<name>]`.
 */
export type NodeDef = { name: string, 
/**
 * Modbus-specific: the device (slave) address this node owns
 * (`[node.<name>].device_address`). `None` for CAN/serial nodes.
 */
deviceAddress?: number | null, notes?: Array<string>, };
