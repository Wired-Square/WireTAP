// src/types/catalogEdit.ts
//
// The `wiretap-catalog` typed edit ops as `catalog.edits` and `catalog.build` read
// them, generated from Rust. `SignalFields` and `EditOp` are copied from the lib's
// pinned declarations (`tests/ts_edit.rs`) until its generated `SignalFields.ts`
// imports the `Endianness` and `Confidence` it names.

import type { CanConfigFields } from "../generated/CanConfigFields";
import type { Confidence } from "../generated/Confidence";
import type { DisplayHint } from "../generated/DisplayHint";
import type { Endianness } from "../generated/Endianness";
import type { FrameFields } from "../generated/FrameFields";
import type { MetaFields } from "../generated/MetaFields";
import type { ModbusConfigFields } from "../generated/ModbusConfigFields";
import type { MuxFields } from "../generated/MuxFields";
import type { Protocol } from "../generated/Protocol";
import type { SerialConfigFields } from "../generated/SerialConfigFields";

export type { CanConfigFields, FrameFields, MetaFields, ModbusConfigFields, MuxFields, SerialConfigFields };

export type SignalFields = { name?: string, start_bit?: number, bit_length?: number, factor?: number | null, offset?: number | null, unit?: string | null, signed?: boolean | null, byte_order?: Endianness | "" | null, min?: number | null, max?: number | null, format?: string | null, confidence?: Confidence | "" | null, enum?: { [key in string]: string }, notes?: string | Array<string> | null, display?: DisplayHint | null, };

export type EditOp = { "op": "SetTable", path: Array<string>, value: { [key in string]: unknown }, managed_keys?: Array<string>, replace_contents?: boolean, sort_parent_numeric?: boolean, skip_if_exists?: boolean, error_if_exists?: boolean, } | { "op": "UpsertFrame", protocol: string, key: string, value: { [key in string]: unknown }, managed_keys?: Array<string>, rename_from?: string | null, initial_signals?: Array<{ [key in string]: unknown }>, } | { "op": "UpsertArrayItem", array_path: Array<string>, value: { [key in string]: unknown }, index?: number | null, sort_keys?: Array<string>, } | { "op": "RemoveArrayItem", array_path: Array<string>, index: number, remove_if_empty?: boolean, } | { "op": "RenameKey", parent_path: Array<string>, old: string, new: string, set_value?: { [key in string]: unknown } | null, managed_keys?: Array<string>, sort_numeric?: boolean, update_transmitter_refs?: boolean, error_if_exists?: boolean, } | { "op": "DeleteAtPath", path: Array<string>, sort_parent_numeric?: boolean, } | { "op": "UpsertSignal", owner_path: Array<string>, index?: number | null, signal: SignalFields, } | { "op": "SetFrame", protocol: Protocol, key: string, rename_from?: string | null, frame: FrameFields, } | { "op": "AddFrame", protocol: Protocol, key: string, frame: FrameFields, } | { "op": "SetMux", owner_path: Array<string>, mux: MuxFields, } | { "op": "SetMeta", meta: MetaFields, } | { "op": "SetCanConfig", config: CanConfigFields, } | { "op": "SetSerialConfig", config: SerialConfigFields, } | { "op": "SetModbusConfig", config: ModbusConfigFields, };
