import { describe, it, expect } from "vitest";
import { exportItemCount, type ExportCountSources } from "../apps/discovery/exportItemCount";

const openedByteCapture: ExportCountSources = {
  dataMode: "frames",
  byteCount: 70,
  captureMode: { enabled: true, totalFrames: 70 },
  isSerialMode: true,
  framedCaptureId: null,
  backendFrameCount: 0,
  clientFramedCount: 0,
  liveFrameCount: 70,
};

describe("Discovery's export count", () => {
  it("a framed byte capture's export counts its framed messages", () => {
    expect(exportItemCount({ ...openedByteCapture, framedCaptureId: "framed", backendFrameCount: 5 })).toBe(5);
    expect(exportItemCount({ ...openedByteCapture, clientFramedCount: 5 })).toBe(5);
  });

  it("a byte export counts bytes, and a frame capture counts its frames", () => {
    expect(exportItemCount({ ...openedByteCapture, dataMode: "bytes", framedCaptureId: "framed", backendFrameCount: 5 })).toBe(70);
    expect(exportItemCount({ ...openedByteCapture, isSerialMode: false, captureMode: { enabled: true, totalFrames: 1200 } })).toBe(1200);
  });
});
