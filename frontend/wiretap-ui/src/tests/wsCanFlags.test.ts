// The Rust half of this wire contract is the `batch_*` tests in ws/protocol.rs.

import { describe, it, expect } from "vitest";
import { decodeFrameBatch, ENVELOPE_HEADER_SIZE, FrameType } from "../services/wsProtocol";
import { CanFlags } from "../generated/wireConstants";

function canEnvelope(frameType: number, canFlags: number, idFlags: number, payload: number[]): ArrayBuffer {
  const buf = new ArrayBuffer(ENVELOPE_HEADER_SIZE + 4 + payload.length);
  const view = new DataView(buf);
  view.setBigUint64(0, 999n, true);
  view.setUint8(8, 0);
  view.setUint8(9, frameType);
  view.setUint8(10, canFlags);
  view.setUint32(11, 4 + payload.length, true);
  view.setUint32(ENVELOPE_HEADER_SIZE, idFlags, true);
  new Uint8Array(buf).set(payload, ENVELOPE_HEADER_SIZE + 4);
  return buf;
}

describe("CAN flags on the frame batch", () => {
  it("a remote frame's requested length arrives as zero bytes and leaves no payload", () => {
    const [frame] = decodeFrameBatch(canEnvelope(FrameType.Can, CanFlags.RTR, 0x321, [0, 0, 0, 0]), 0);
    expect(frame).toMatchObject({ protocol: "can", frame_id: 0x321, is_rtr: true, dlc: 4, bytes: [] });
  });

  it("a CAN FD frame keeps BRS and ESI", () => {
    const flags = CanFlags.FD | CanFlags.BRS | CanFlags.ESI;
    const [frame] = decodeFrameBatch(canEnvelope(FrameType.CanFd, flags, 0x10, new Array(12).fill(0)), 0);
    expect(frame).toMatchObject({ protocol: "can", is_fd: true, is_brs: true, is_esi: true, is_rtr: false, dlc: 12 });
  });

  it("an extended frame this end sent reads both from the flags byte", () => {
    const flags = CanFlags.EXT | CanFlags.TX;
    const [frame] = decodeFrameBatch(canEnvelope(FrameType.Can, flags, 0x1234, [1]), 0);
    expect(frame).toMatchObject({ frame_id: 0x1234, is_extended: true, direction: "tx" });
  });

  it("a classic frame without flags decodes as before", () => {
    const [frame] = decodeFrameBatch(canEnvelope(FrameType.Can, 0, 0x123, [0xaa]), 0);
    expect(frame).toMatchObject({
      frame_id: 0x123,
      is_extended: false,
      is_fd: false,
      is_rtr: false,
      is_brs: false,
      is_esi: false,
      dlc: 1,
      bytes: [0xaa],
    });
    expect(frame.direction).toBeUndefined();
  });
});
