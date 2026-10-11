import { describe, expect, it } from "vitest";
import { serialConfigOf } from "../utils/frameExport";

describe("serialConfigOf", () => {
  it("drops a header field start counted from the end", () => {
    const config = serialConfigOf({ frame_id_start_byte: -2, frame_id_bytes: 2, source_address_start_byte: 1 });
    expect(config.frameIdStartByte).toBeUndefined();
    expect(config.sourceAddressStartByte).toBe(1);
  });

  it("carries the framing and a little-endian checksum over", () => {
    expect(
      serialConfigOf({
        encoding: "slip",
        frame_id_mask: 0xff00,
        frame_id_start_byte: 1,
        frame_id_bytes: 2,
        frame_id_byte_order: "little",
        min_frame_length: 4,
        header_length: 3,
        checksum: { algorithm: "xor", start_byte: -1, byte_length: 1, calc_start_byte: 0, calc_end_byte: -1 },
      }),
    ).toEqual({
      encoding: "slip",
      frameIdMask: 0xff00,
      frameIdStartByte: 1,
      frameIdBytes: 2,
      frameIdByteOrder: "little",
      minFrameLength: 4,
      headerLength: 3,
      checksum: { algorithm: "xor", startByte: -1, byteLength: 1, calcStartByte: 0, calcEndByte: -1, bigEndian: false },
    });
  });
});
