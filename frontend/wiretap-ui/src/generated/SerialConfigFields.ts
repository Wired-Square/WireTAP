// Generated from the Rust serde types by `npm run gen:types`. Do not edit.
import type { Endianness } from "./Endianness";
import type { HeaderFieldFields } from "./HeaderFieldFields";
import type { Mask } from "./Mask";
import type { SerialChecksumFields } from "./SerialChecksumFields";

/**
 * `[meta.serial]`, for [`super::EditOp::SetSerialConfig`].
 */
export type SerialConfigFields = { encoding?: string | null, byte_order?: Endianness | null, frame_id_mask?: Mask | null, 
/**
 * Not written when 0.
 */
header_length?: number | null, 
/**
 * Not written when 0.
 */
min_frame_length?: number | null, checksum?: SerialChecksumFields | null, 
/**
 * A blank name, or a field with no mask or position, drops the field.
 */
fields?: { [key in string]: HeaderFieldFields }, };
