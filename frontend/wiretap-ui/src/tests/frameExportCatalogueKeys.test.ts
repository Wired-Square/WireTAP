import { describe, it, expect } from "vitest";

import { tomlParse } from "../apps/catalog/toml";
import {
  buildFramesToml,
  buildFramesTomlWithKnowledge,
  type ExportMeta,
} from "../utils/frameExport";
import type { FrameKnowledge, MuxKnowledge } from "../utils/decoderKnowledge";

// The keys asserted here are the ones wiretap-catalog's parse.rs reads:
// `parse_mux`, `parse_can_config` and `parse_serial_config` (with
// `parse_header_fields` for `[meta.serial.fields]`).

const meta: ExportMeta = {
  name: "export",
  version: 1,
  default_byte_order: "big",
  default_interval: 100,
};
const hexId = (id: number) => `0x${id.toString(16).toUpperCase()}`;

function knowledgeWithMux(mux: MuxKnowledge): FrameKnowledge {
  return { frameId: 0x100, length: 8, mux, signals: [] } as unknown as FrameKnowledge;
}

describe("Discovery catalogue export", () => {
  it("an exported mux keeps its selector position", () => {
    const toml = buildFramesTomlWithKnowledge(
      [
        {
          id: 0x100,
          len: 8,
          knowledge: knowledgeWithMux({
            selectorByte: 2,
            selectorStartBit: 16,
            selectorBitLength: 8,
            cases: [1, 2],
            isTwoByte: false,
            source: "mux-detection",
          }),
        },
      ],
      meta,
      hexId,
    );
    const mux = (tomlParse(toml) as any).frame.can["0x100"].mux;

    expect(mux.start_bit).toBe(16);
    expect(mux.bit_length).toBe(8);
  });

  it("an exported two-level mux reads its inner selector from byte 1", () => {
    const toml = buildFramesTomlWithKnowledge(
      [
        {
          id: 0x100,
          len: 8,
          knowledge: knowledgeWithMux({
            selectorByte: -1,
            selectorStartBit: 0,
            selectorBitLength: 16,
            cases: [0x0102],
            isTwoByte: true,
            source: "mux-detection",
          }),
        },
      ],
      meta,
      hexId,
    );
    const mux = (tomlParse(toml) as any).frame.can["0x100"].mux;

    expect([mux.start_bit, mux.bit_length]).toEqual([0, 8]);
    expect([mux["1"].mux.start_bit, mux["1"].mux.bit_length]).toEqual([8, 8]);
  });

  it("an exported serial catalogue declares its id and source address as header fields", () => {
    const toml = buildFramesTomlWithKnowledge(
      [{ id: 0x10, len: 8, protocol: "serial" }],
      meta,
      hexId,
      {
        frame_id_start_byte: 1,
        frame_id_bytes: 2,
        frame_id_byte_order: "little",
        source_address_start_byte: 0,
        source_address_bytes: 1,
      },
    );
    const serial = (tomlParse(toml) as any).meta.serial;

    expect(serial.byte_order).toBe("big");
    expect(serial.fields.id).toEqual({ mask: 0xffff00, byte_order: "little" });
    expect(serial.fields.source_address).toEqual({ mask: 0xff });
  });

  it("a plain CAN export puts its byte order and interval under [meta.can]", () => {
    const toml = buildFramesToml([{ id: 0x100, len: 8 }], meta, hexId);
    const can = (tomlParse(toml) as any).meta.can;

    expect(can).toEqual({ default_byte_order: "big", default_interval: 100 });
  });
});
