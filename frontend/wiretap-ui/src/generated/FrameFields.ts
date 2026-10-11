// Generated from the Rust serde types by `npm run gen:types`. Do not edit.
import type { RegisterType } from "./RegisterType";

/**
 * A frame's own keys, for [`super::EditOp::SetFrame`]. Its signals, mux and
 * checksums are other ops'. Keys of another protocol than the op's are ignored.
 * A value the frame would inherit anyway, from its `copy` or `mirror_of` source
 * or a protocol default, is not written.
 */
export type FrameFields = { 
/**
 * Bytes, but registers (or coils) for Modbus, which must cover at least one.
 */
length?: number | null, transmitter?: string | null, interval_ms?: number | null, notes?: string | Array<string> | null, extended?: boolean | null, fd?: boolean | null, bus?: number | null, copy?: string | null, mirror_of?: string | null, delimiter?: Array<number>, 
/**
 * Not written when the key already names the register.
 */
register_number?: number | null, node_address?: number | null, 
/**
 * Not written when `holding`.
 */
register_type?: RegisterType | null, };
