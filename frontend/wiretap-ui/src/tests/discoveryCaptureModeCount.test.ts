import { describe, it, expect, vi } from "vitest";

vi.mock("../api/settings", () => ({
  tlog: { info: vi.fn(), debug: vi.fn(), verbose: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../services/memoryDiag", () => ({ trackAlloc: vi.fn() }));

import { capturedFrameCount, useDiscoveryFrameStore } from "../stores/discoveryFrameStore";

describe("capture mode's frame total", () => {
  it("an opened byte capture holds no frames, whatever its byte count", () => {
    useDiscoveryFrameStore.getState().enableCaptureMode(capturedFrameCount({ kind: "bytes", count: 70 }));
    expect(useDiscoveryFrameStore.getState().captureMode).toEqual({ enabled: true, totalFrames: 0 });
  });

  it("an opened frame capture holds its count", () => {
    useDiscoveryFrameStore.getState().enableCaptureMode(capturedFrameCount({ kind: "frames", count: 1200 }));
    expect(useDiscoveryFrameStore.getState().captureMode.totalFrames).toBe(1200);
  });
});
