// Generated from the Rust serde types by `npm run gen:types`. Do not edit.
import type { Endianness } from "./Endianness";
import type { HeaderFieldFields } from "./HeaderFieldFields";
import type { Mask } from "./Mask";

/**
 * `[meta.can]`, for [`super::EditOp::SetCanConfig`].
 */
export type CanConfigFields = { 
/**
 * Not written when it is decode's default and the file states none.
 */
default_byte_order?: Endianness | null, default_interval?: number | null, default_extended?: boolean | null, default_fd?: boolean | null, frame_id_mask?: Mask | null, 
/**
 * A blank name, or a field with no mask or position, drops the field.
 */
fields?: { [key in string]: HeaderFieldFields }, };
