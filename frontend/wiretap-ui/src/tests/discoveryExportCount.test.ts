import { describe, it, expect } from "vitest";
import { exportItemCount, type ExportCountSources } from "../apps/discovery/exportItemCount";

const framed = { framed_capture_id: "framed", frame_count: 5, filtered_capture_id: null, filtered_count: 0, protocol: "serial" };

const openedByteCapture: ExportCountSources = {
  dataMode: "frames",
  byteCount: 70,
  captureMode: { enabled: true, totalFrames: 70 },
  isSerialMode: true,
  framing: null,
  liveFrameCount: 70,
};

describe("Discovery's export count", () => {
  it("a framed byte capture's export counts its framed messages", () => {
    expect(exportItemCount({ ...openedByteCapture, framing: framed })).toBe(5);
  });

  it("a byte export counts bytes, and a frame capture counts its frames", () => {
    expect(exportItemCount({ ...openedByteCapture, dataMode: "bytes", framing: framed })).toBe(70);
    expect(exportItemCount({ ...openedByteCapture, isSerialMode: false, captureMode: { enabled: true, totalFrames: 1200 } })).toBe(1200);
  });
});
