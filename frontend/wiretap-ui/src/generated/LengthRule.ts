// Generated from the Rust serde types by `npm run gen:types`. Do not edit.
import type { Selector } from "./Selector";
import type { VendorLen } from "./VendorLen";

/**
 * A [`VendorLength`] without its function code, which a catalogue's
 * `[meta.modbus.function_code.<code>]` table keys it by.
 */
export type LengthRule = { when?: Selector | null, len: VendorLen, };
