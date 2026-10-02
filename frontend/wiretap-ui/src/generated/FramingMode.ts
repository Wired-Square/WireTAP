// Generated from the Rust serde types by `npm run gen:types`. Do not edit.

/**
 * How a serial byte stream is cut into frames, in every path that frames one:
 * the port, a live framing change and re-framing a capture. `Raw` is no
 * framing, the bytes as read.
 */
export type FramingMode = "raw" | "slip" | "delimiter" | "modbus_rtu";
