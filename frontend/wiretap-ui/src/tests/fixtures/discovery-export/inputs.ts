import type {
  ExportFrame,
  ExportFrameWithKnowledge,
  ExportMeta,
  ModbusExportConfig,
  SerialFrameConfig,
} from "../../../utils/frameExport";
import type { FrameKnowledge, MuxKnowledge } from "../../../utils/decoderKnowledge";

export const hexId = (id: number) => `0x${id.toString(16).toUpperCase()}`;

export const canMeta: ExportMeta = {
  name: 'Discovery "export"',
  version: 2,
  default_byte_order: "big",
  default_interval: 100,
};

function knowledge(frameId: number, length: number, extra: Partial<FrameKnowledge>): FrameKnowledge {
  return { frameId, length, signals: [], notes: [], ...extra };
}

const oneLevelMux: MuxKnowledge = {
  selectorByte: 0,
  selectorStartBit: 0,
  selectorBitLength: 8,
  cases: [1, 2],
  caseKnowledge: new Map([
    [
      1,
      {
        caseValue: 1,
        signals: [{ name: "speed kph", startBit: 16, bitLength: 16, source: "user", confidence: "medium" }],
        multiBytePatterns: [{ startByte: 4, length: 2, pattern: "counter16", correlatedRollover: true }],
      },
    ],
  ]),
  isTwoByte: false,
  source: "mux-detection",
};

const twoLevelMux: MuxKnowledge = {
  selectorByte: -1,
  selectorStartBit: 0,
  selectorBitLength: 16,
  cases: [0x0102, 0x0103, 0x0201],
  isTwoByte: true,
  source: "mux-detection",
};

export const knowledgeCanFrames: ExportFrameWithKnowledge[] = [
  {
    id: 0x100,
    len: 8,
    knowledge: knowledge(0x100, 8, {
      notes: ["seen at 10 Hz", "rolls over at 0xFFFF"],
      intervalMs: 50,
      signals: [
        { name: "rpm", startBit: 16, bitLength: 16, source: "user", confidence: "high", endianness: "little" },
      ],
      multiBytePatterns: [{ startByte: 4, length: 2, pattern: "sensor16", endianness: "little" }],
    }),
  },
  { id: 0x200, len: 8, knowledge: knowledge(0x200, 8, { mux: oneLevelMux, intervalMs: 100 }) },
  { id: 0x300, len: 8, knowledge: knowledge(0x300, 8, { mux: twoLevelMux }) },
  { id: 0x18ff0001, len: 4, isExtended: true },
];

export const serialMeta: ExportMeta = { ...canMeta, name: "serial export", default_byte_order: "little" };

export const serialFrames: ExportFrameWithKnowledge[] = [
  { id: 0x10, len: 8, protocol: "serial", knowledge: knowledge(0x10, 8, { intervalMs: 250, notes: ["status"] }) },
  { id: 0x11, len: 6, protocol: "serial" },
];

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
