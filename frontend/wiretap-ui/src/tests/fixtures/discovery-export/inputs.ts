import type { ExportFrame, ExportMeta, ModbusExportConfig, SerialFrameConfig } from "../../../utils/frameExport";

export const hexId = (id: number) => `0x${id.toString(16).toUpperCase()}`;

export const canMeta: ExportMeta = {
  name: 'Discovery "export"',
  version: 2,
  default_byte_order: "big",
  default_interval: 100,
};

export const serialConfig: SerialFrameConfig = {
  encoding: "slip",
  frame_id_mask: 0xff00,
  frame_id_start_byte: 1,
  frame_id_bytes: 2,
  frame_id_byte_order: "little",
  source_address_start_byte: 0,
  source_address_bytes: 1,
  min_frame_length: 4,
  header_length: 3,
  checksum: { algorithm: "xor", start_byte: -1, byte_length: 1, calc_start_byte: 0, calc_end_byte: -1, big_endian: false },
};

export const plainFrames: ExportFrame[] = [
  { id: 0x100, len: 8 },
  { id: 0x7ff, len: 2 },
  { id: 0x18ff0001, len: 8, isExtended: true },
];

export const modbusMeta: ExportMeta = { ...canMeta, name: "SH10RT scan" };

export const modbusRegisters = [
  { frameId: 13000, dlc: 2 },
  { frameId: 5000, dlc: 4 },
  { frameId: 5002, dlc: 2 },
];

export const modbusConfig: ModbusExportConfig = {
  device_address: 3,
  register_base: 0,
  register_type: "input",
  default_interval: 1000,
};
