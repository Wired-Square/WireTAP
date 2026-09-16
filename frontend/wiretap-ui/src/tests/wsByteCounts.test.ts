// The ByteCounts (0x19) wire contract, from the TypeScript side.
//
// Raw serial bytes are never streamed — this one message is the entire byte signal, so a
// layout mismatch between Rust and TS shows up as "Waiting for serial data…" forever
// rather than as an error. Build the payload exactly as Rust's `encode_byte_counts` does
// (total u64 LE + u16 LE length-prefixed capture id) and assert the decoder reads it.
//
// The Rust half of this contract is pinned by `byte_counts_layout` in ws/protocol.rs.

import { describe, it, expect } from "vitest";
import { decodeByteCounts, MsgType } from "../services/wsProtocol";

/** Mirrors `encode_byte_counts` in crates/wiretap-app/src/ws/protocol.rs. */
function encodeByteCounts(total: bigint, captureId: string): DataView {
  const id = new TextEncoder().encode(captureId);
  const buf = new ArrayBuffer(8 + 2 + id.length);
  const view = new DataView(buf);
  view.setBigUint64(0, total, true);
  view.setUint16(8, id.length, true);
  new Uint8Array(buf).set(id, 10);
  return view;
}

describe("ByteCounts wire format", () => {
  it("uses opcode 0x19", () => {
    expect(MsgType.ByteCounts).toBe(0x19);
  });

  it("decodes the total and the capture id", () => {
    const decoded = decodeByteCounts(encodeByteCounts(10_617n, "cap_dheis7"));

    expect(decoded).toEqual({ total: 10_617, captureId: "cap_dheis7" });
  });

  it("decodes an empty capture id rather than reading past the payload", () => {
    expect(decodeByteCounts(encodeByteCounts(0n, ""))).toEqual({ total: 0, captureId: "" });
  });

  it("reads the id at a non-zero byteOffset, as the transport hands it over", () => {
    // wsTransport passes a DataView over the framed message, offset past the 4-byte
    // header — so decodeLengthPrefixedStr must respect byteOffset, not assume 0.
    const payload = encodeByteCounts(7n, "cap_1");
    const framed = new ArrayBuffer(4 + payload.byteLength);
    new Uint8Array(framed).set(new Uint8Array(payload.buffer), 4);

    const decoded = decodeByteCounts(new DataView(framed, 4));

    expect(decoded).toEqual({ total: 7, captureId: "cap_1" });
  });

  it("carries a total past 2^32, which a u32 count would wrap", () => {
    const decoded = decodeByteCounts(encodeByteCounts(5_000_000_000n, "cap_big"));

    expect(decoded.total).toBe(5_000_000_000);
  });
});
