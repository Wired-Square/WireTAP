// The Rust half is `stream_ended_keeps_its_wire_and_json` in ws/dispatch.rs; these are its bytes.

import { describe, it, expect } from "vitest";
import { decodeStreamEnded } from "../services/wsProtocol";

const view = (bytes: number[]) => new DataView(new Uint8Array(bytes).buffer);

describe("StreamEnded wire format", () => {
  it("decodes Rust's golden payloads to its JSON", () => {
    expect(decodeStreamEnded(view([4, 7, 42, 0, 0, 0, 4, 0, 98, 117, 102, 49, 6, 0, 102, 114, 97, 109, 101, 115]))).toEqual({
      reason: "paused",
      capture_available: true,
      capture_id: "buf1",
      capture_kind: "frames",
      count: 42,
      time_range: null,
    });
    expect(
      decodeStreamEnded(
        view([2, 15, 42, 0, 0, 0, 3, 0, 98, 95, 50, 5, 0, 98, 121, 116, 101, 115, 232, 3, 0, 0, 0, 0, 0, 0, 208, 7, 0, 0, 0, 0, 0, 0]),
      ),
    ).toEqual({
      reason: "error",
      capture_available: true,
      capture_id: "b_2",
      capture_kind: "bytes",
      count: 42,
      time_range: [1000, 2000],
    });
    expect(decodeStreamEnded(view([0, 0, 42, 0, 0, 0]))).toEqual({
      reason: "complete",
      capture_available: false,
      capture_id: null,
      capture_kind: null,
      count: 42,
      time_range: null,
    });
  });

  it("reads an unknown reason as stopped and an unknown kind as none", () => {
    const info = decodeStreamEnded(view([9, 4, 0, 0, 0, 0, 3, 0, 120, 120, 120]));
    expect(info.reason).toBe("stopped");
    expect(info.capture_kind).toBeNull();
  });
});
