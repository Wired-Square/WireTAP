import { describe, expect, it } from "vitest";
import { configFromSerialChecksum, serialChecksumFromConfig } from "../apps/discovery/views/serial/checksumConfig";
import type { ChecksumConfig } from "../apps/discovery/views/serial/serialTypes";

const crc16 = (endianness: ChecksumConfig["endianness"]): ChecksumConfig => ({
  algorithm: "crc16_modbus",
  numBytes: 2,
  startByte: -2,
  endianness,
  calcStartByte: 0,
  calcEndByte: -2,
});

describe("Discovery's serial checksum and the catalogue's", () => {
  it.each(["big", "little"] as const)("round-trips a %s-endian CRC-16", (endianness) => {
    expect(configFromSerialChecksum(serialChecksumFromConfig(crc16(endianness))!)).toEqual(crc16(endianness));
  });

  it("gives a one-byte checksum no byte order", () => {
    const xor = { ...crc16("big"), algorithm: "xor" as const, numBytes: 1, startByte: -1 };
    expect(serialChecksumFromConfig(xor)?.endianness).toBeUndefined();
  });

  it("reads no byte order or calculation end as little-endian, up to the last byte", () => {
    const config = configFromSerialChecksum({ algorithm: "sum8", startByte: -1, byteLength: 1, calcStartByte: 0 });
    expect(config).toMatchObject({ endianness: "little", calcEndByte: -1 });
  });

  it("keeps an unidentified checksum out of the catalogue", () => {
    expect(serialChecksumFromConfig({ ...crc16("big"), algorithm: "unknown" })).toBeNull();
  });
});
