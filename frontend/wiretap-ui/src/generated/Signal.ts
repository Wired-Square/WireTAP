// Generated from the Rust serde types by `npm run gen:types`. Do not edit.
import type { Confidence } from "./Confidence";
import type { DisplayHint } from "./DisplayHint";
import type { Endianness } from "./Endianness";
import type { SignalFormat } from "./SignalFormat";

/**
 * A single decoded field, resolved from the catalogue. Fields are optional
 * because mux-case and inherited signals may carry only overrides; a fully
 * resolved signal for decode has `name`/`start_bit`/`bit_length` set.
 */
export type Signal = { name?: string | null, startBit?: number | null, bitLength?: number | null, signed?: boolean | null, 
/**
 * Byte order (the catalogue's legacy key is `endianness`; the newer key is
 * `byte_order`). Stored here as the resolved byte order.
 */
endianness?: Endianness | null, wordOrder?: Endianness | null, factor?: number | null, offset?: number | null, unit?: string | null, min?: number | null, max?: number | null, format?: SignalFormat | null, 
/**
 * Value↔label map (`enum` table in the catalogue). Keys are the numeric
 * register/field value.
 */
enum?: { [key in string]: string } | null, confidence?: Confidence | null, display?: DisplayHint | null, 
/**
 * Free-text notes on the signal (`notes` — a string or array in TOML).
 */
notes?: Array<string>, 
/**
 * True when this signal was inherited from a mirror/copy source rather
 * than defined directly on the frame.
 */
inherited?: boolean, 
/**
 * Modbus-specific: the signal's own register number, synthesised from the
 * frame's base register plus the signal's bit offset (word registers add
 * `start_bit / 16`; coils/discretes add `start_bit`). `None` for non-Modbus.
 */
modbusRegister?: number | null, 
/**
 * Modbus-specific: how many registers (or coils) this signal spans.
 */
modbusRegisterCount?: number | null, };
