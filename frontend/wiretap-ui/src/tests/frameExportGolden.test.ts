// P7 L2: what frameExport.ts returns, pinned before the export ops move to Rust.
// A header field's mask is today's f64 product, so a field wider than 6 bytes is rounded.

import { describe, it } from "vitest";
import type { Protocol } from "../types/catalogModel";
import { formatFrameId } from "../utils/frameIds";
import {
  framesCatalogOps,
  headOps,
  modbusCatalogOps,
  serialReservedSpans,
  type ExportFrame,
  type ExportMeta,
  type ModbusExportConfig,
  type SerialFrameConfig,
} from "../utils/frameExport";
import { expectGolden, type GoldenCase } from "./catalogGoldens";

const META: Record<string, ExportMeta> = {
  plain: { name: "Export", version: 2, default_byte_order: "big", default_interval: 100 },
  "version 0, negative interval": { name: "Zero", version: 0, default_byte_order: "little", default_interval: -5 },
  "quoted name": { name: 'Discovery "export"', version: 7, default_byte_order: "little", default_interval: 0 },
};

const xor = { algorithm: "xor", start_byte: -1, byte_length: 1, calc_start_byte: 0, calc_end_byte: -1 };

const SERIAL: Record<string, SerialFrameConfig> = {
  empty: {},
  "id 0/1": { frame_id_start_byte: 0, frame_id_bytes: 1 },
  "id 1/2 little, source 0/1, xor at -1": {
    encoding: "slip",
    frame_id_mask: 0xff00,
    frame_id_start_byte: 1,
    frame_id_bytes: 2,
    frame_id_byte_order: "little",
    source_address_start_byte: 0,
    source_address_bytes: 1,
    min_frame_length: 4,
    header_length: 3,
    checksum: { ...xor, big_endian: false },
  },
  "id 2/2 big, source 4/2 little, crc16 at -2 big": {
    encoding: "modbus_rtu",
    frame_id_start_byte: 2,
    frame_id_bytes: 2,
    frame_id_byte_order: "big",
    source_address_start_byte: 4,
    source_address_bytes: 2,
    source_address_byte_order: "little",
    checksum: { algorithm: "crc16_modbus", start_byte: -2, byte_length: 2, calc_start_byte: 0, calc_end_byte: -2, big_endian: true },
  },
  "id 3/3, source 6/1": { frame_id_start_byte: 3, frame_id_bytes: 3, source_address_start_byte: 6, source_address_bytes: 1 },
  "id 4/4 (mask past 2^53)": { frame_id_start_byte: 4, frame_id_bytes: 4 },
  "id 0/7 (mask past 2^53)": { frame_id_start_byte: 0, frame_id_bytes: 7 },
  "id 0/8 (mask past 2^53)": { frame_id_start_byte: 0, frame_id_bytes: 8 },
  "id 6/2": { frame_id_start_byte: 6, frame_id_bytes: 2 },
  "negative id start is no field": { frame_id_start_byte: -2, frame_id_bytes: 2, source_address_start_byte: 1 },
  "id start without bytes": { frame_id_start_byte: 1 },
  "checksum at 5 with no calc end": { checksum: { algorithm: "sum8", start_byte: 5, byte_length: 1, calc_start_byte: 1, calc_end_byte: 5 } },
};

const FRAMES: Record<string, ExportFrame[]> = {
  "can standard and extended": [
    { id: 0x100, len: 8 },
    { id: 0x7ff, len: 2 },
    { id: 0x18ff0001, len: 8, isExtended: true },
    { id: 0x5, len: 0, isExtended: true },
  ],
  "can fd lengths": [
    { id: 0x123, len: 64, protocol: "can" },
    { id: 0x124, len: 12, protocol: "can" },
  ],
  "serial ids": [
    { id: 0x01, len: 6, protocol: "serial" },
    { id: 0xabcd, len: 10, protocol: "serial" },
  ],
  "modbus registers": [{ id: 40001, len: 2, protocol: "modbus" }],
  "first protocol wins": [{ id: 1, len: 1 }, { id: 2, len: 2, protocol: "serial" }, { id: 3, len: 3, protocol: "can" }],
  empty: [],
  "modbus_rtu is refused": [{ id: 0x0103, len: 8, protocol: "modbus_rtu" }],
};

const REGISTERS = [
  { frameId: 13000, dlc: 2 },
  { frameId: 5000, dlc: 4 },
  { frameId: 5002, dlc: 3 },
  { frameId: 1, dlc: 1 },
  { frameId: 0, dlc: 0 },
  { frameId: 7, dlc: 5 },
];

const caught = (run: () => unknown) => {
  try {
    return run();
  } catch (e) {
    return { error: String(e) };
  }
};

function cases(): GoldenCase[] {
  const out: GoldenCase[] = [];
  for (const [metaName, meta] of Object.entries(META)) {
    for (const protocol of ["can", "modbus"] as Protocol[]) {
      out.push({ name: `headOps ${protocol} ${metaName}`, input: { protocol, meta }, expected: headOps(protocol, meta) });
    }
  }
  for (const [name, serialConfig] of Object.entries(SERIAL)) {
    for (const metaName of ["plain", "version 0, negative interval"]) {
      const meta = META[metaName];
      out.push({ name: `headOps serial ${metaName} ${name}`, input: { protocol: "serial", meta, serialConfig }, expected: headOps("serial", meta, serialConfig) });
    }
    out.push({ name: `serialReservedSpans ${name}`, input: serialConfig, expected: serialReservedSpans(serialConfig) });
  }
  for (const [name, frames] of Object.entries(FRAMES)) {
    for (const mode of ["hex", "decimal"] as const) {
      out.push({
        name: `framesCatalogOps ${name} ${mode}`,
        input: { frames, meta: META.plain, formatId: `formatFrameId(id, "${mode}", isExtended)` },
        expected: caught(() => framesCatalogOps(frames, META.plain, (id, ext) => formatFrameId(id, mode, ext))),
      });
    }
  }
  for (const register_type of ["holding", "input", "coil", "discrete"] as const) {
    for (const register_base of [0, 1] as const) {
      const config: ModbusExportConfig = { device_address: 3, register_base, register_type, default_interval: 1000 };
      out.push({
        name: `modbusCatalogOps ${register_type} base ${register_base}`,
        input: { registers: REGISTERS, meta: META.plain, config },
        expected: modbusCatalogOps(REGISTERS, META.plain, config),
      });
    }
  }
  out.push({
    name: "modbusCatalogOps no registers, version 0",
    input: { registers: [], meta: META["version 0, negative interval"], config: { device_address: 247, register_base: 1, register_type: "holding", default_interval: 0 } },
    expected: modbusCatalogOps([], META["version 0, negative interval"], { device_address: 247, register_base: 1, register_type: "holding", default_interval: 0 }),
  });
  return out;
}

describe("frameExport golden", () => {
  it("matches fixtures/data/frameExportGolden.json", async () => {
    await expectGolden("frameExportGolden.json", cases(), "data");
  });
});
