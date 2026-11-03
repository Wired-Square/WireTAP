// Discovery's framing dialog used to translate its "delimiter" into the wire's
// "raw", which the port read as *no framing*. Both now say "delimiter".

import { describe, it, expect } from "vitest";
import { backendFramingConfig, type FramingConfig } from "../stores/discoverySerialStore";
import { MsgType } from "../services/wsProtocol";

const wireFor = (config: FramingConfig) => backendFramingConfig(config, 0, null, null);

describe("Discovery framing on the wire", () => {
  it("sends the dialog's delimiter as delimiter, with its bytes and length", () => {
    expect(wireFor({ mode: "delimiter", delimiterHex: "0D0A", maxFrameLength: 512 })).toMatchObject({
      mode: "delimiter",
      delimiter: "0D0A",
      max_length: 512,
    });
  });

  it("sends SLIP and Modbus RTU under their own names", () => {
    expect(wireFor({ mode: "slip" }).mode).toBe("slip");
    expect(wireFor({ mode: "modbus_rtu", validateCrc: true }).mode).toBe("modbus_rtu");
  });

  it("sends no minimum length for 0, and the extraction configs in the wire's shape", () => {
    const id = { startByte: 0, numBytes: 2, endianness: "big" as const };
    const src = { startByte: -1, numBytes: 1, endianness: "little" as const };
    expect(backendFramingConfig({ mode: "slip" }, 0, null, null)).toMatchObject({
      min_length: undefined,
      frame_id_config: undefined,
      source_address_config: undefined,
    });
    expect(backendFramingConfig({ mode: "slip" }, 4, id, src)).toMatchObject({
      min_length: 4,
      frame_id_config: { start_byte: 0, num_bytes: 2, big_endian: true },
      source_address_config: { start_byte: -1, num_bytes: 1, big_endian: false },
    });
  });

  it("pushes the framing state as message 0x25", () => {
    expect(MsgType.FramingState).toBe(0x25);
  });
});
