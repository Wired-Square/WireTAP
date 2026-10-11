// Generated from the Rust serde types by `npm run gen:types`. Do not edit.
import type { FrameChecksum } from "./FrameChecksum";
import type { FrameTunnel } from "./FrameTunnel";
import type { Mux } from "./Mux";
import type { Protocol } from "./Protocol";
import type { RegisterType } from "./RegisterType";
import type { Signal } from "./Signal";

/**
 * A resolved frame: one CAN message / serial frame / Modbus register read,
 * with its signals, mux, and inheritance applied.
 */
export type Frame = { 
/**
 * The authored catalogue table key (CAN: `"0x103"`; serial/modbus: the
 * frame name). The stable identifier the editor uses for tree paths and
 * comment-preserving edits — preserved verbatim, unlike the numeric
 * `frame_id`.
 */
key: string, 
/**
 * Numeric identifier: CAN arbitration ID, serial frame id, or Modbus
 * register number. [`NAME_KEYED_FRAME_ID`] for a serial frame keyed by a name.
 */
frameId: number, protocol: Protocol, 
/**
 * A CAN frame's `name`, or the catalogue table key when it carries meaning
 * (e.g. a Modbus frame's `ems_control`).
 */
name?: string | null, 
/**
 * Frame length in bytes.
 */
length: number, transmitter?: string | null, interval?: number | null, bus?: number | null, isExtended?: boolean | null, isFd?: boolean | null, signals: Array<Signal>, mux?: Mux | null, 
/**
 * Set when the frame carries a tunnelled protocol instead of a bit layout.
 */
tunnel?: FrameTunnel | null, mirrorOf?: string | null, copyFrom?: string | null, 
/**
 * Modbus-specific: register class.
 */
modbusRegisterType?: RegisterType | null, 
/**
 * Modbus-specific: register count (not bytes).
 */
modbusRegisterCount?: number | null, 
/**
 * Modbus-specific: the slave node this register is read from
 * (`[frame.modbus.<name>].node` → `[node.<name>]`).
 */
modbusNode?: string | null, 
/**
 * Modbus-specific: resolved device (slave) address — from the assigned
 * node, the legacy `[meta.modbus].device_address`, else `1`.
 */
modbusDeviceAddress?: number | null, 
/**
 * Serial-specific: explicit frame delimiter bytes (raw encoding).
 */
delimiter?: Array<number> | null, 
/**
 * Free-text notes, normalised from the catalogue's `notes` (a string or an
 * array of strings).
 */
notes?: Array<string>, 
/**
 * Per-frame checksum definitions (CAN/serial; absent on Modbus).
 */
checksums?: Array<FrameChecksum>, 
/**
 * Names of fields whose value was inherited (from a per-frame default,
 * a `copy`/`mirror_of` source, or auto-detection) rather than set
 * explicitly on this frame. Drives the editor's "(inherited)" labels.
 * Possible entries: `length`, `transmitter`, `interval`, `extended`,
 * `fd`, `signals` (some are [`Signal::inherited`]), `mux` (all of it, from
 * a `mirror_of` source), `deviceAddress`, `registerBase`.
 */
inheritedFields?: Array<string>, };
