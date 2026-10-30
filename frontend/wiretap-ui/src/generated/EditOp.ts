// Generated from the Rust serde types by `npm run gen:types`. Do not edit.
import type { CanConfigFields } from "./CanConfigFields";
import type { FrameFields } from "./FrameFields";
import type { MetaFields } from "./MetaFields";
import type { ModbusConfigFields } from "./ModbusConfigFields";
import type { MuxFields } from "./MuxFields";
import type { Protocol } from "./Protocol";
import type { SerialConfigFields } from "./SerialConfigFields";
import type { SignalFields } from "./SignalFields";

/**
 * One comment-preserving edit, as an edit request's params carry it
 * (internally tagged on `op`); an extra `content` param is ignored.
 */
export type EditOp = { "op": "SetTable", path: Array<string>, value: { [key in string]: unknown }, managed_keys?: Array<string>, replace_contents?: boolean, sort_parent_numeric?: boolean, skip_if_exists?: boolean, error_if_exists?: boolean, } | { "op": "UpsertFrame", protocol: string, key: string, value: { [key in string]: unknown }, managed_keys?: Array<string>, rename_from?: string | null, initial_signals?: Array<{ [key in string]: unknown }>, } | { "op": "UpsertArrayItem", array_path: Array<string>, value: { [key in string]: unknown }, index?: number | null, sort_keys?: Array<string>, } | { "op": "RemoveArrayItem", array_path: Array<string>, index: number, remove_if_empty?: boolean, } | { "op": "RenameKey", parent_path: Array<string>, old: string, new: string, set_value?: { [key in string]: unknown } | null, managed_keys?: Array<string>, sort_numeric?: boolean, update_transmitter_refs?: boolean, error_if_exists?: boolean, } | { "op": "DeleteAtPath", path: Array<string>, sort_parent_numeric?: boolean, } | { "op": "UpsertSignal", owner_path: Array<string>, index?: number | null, signal: SignalFields, } | { "op": "SetFrame", protocol: Protocol, key: string, rename_from?: string | null, frame: FrameFields, } | { "op": "AddFrame", protocol: Protocol, key: string, frame: FrameFields, } | { "op": "SetMux", owner_path: Array<string>, mux: MuxFields, } | { "op": "SetMeta", meta: MetaFields, } | { "op": "SetCanConfig", config: CanConfigFields, } | { "op": "SetSerialConfig", config: SerialConfigFields, } | { "op": "SetModbusConfig", config: ModbusConfigFields, };
