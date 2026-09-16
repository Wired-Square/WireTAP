// Frame-picker identity when the picker is rebuilt from a capture.
//
// Frame identity is (protocol, frame_id). The capture-mode picker used to stamp a single
// hardcoded protocol on every row, so CAN 0x100 and Modbus register 256 shared one key —
// they could not be selected apart, and their metadata was merged into one row.

import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../api/settings", () => ({
  tlog: { info: vi.fn(), debug: vi.fn(), verbose: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../services/memoryDiag", () => ({ trackAlloc: vi.fn() }));

import { useDiscoveryFrameStore } from "../stores/discoveryFrameStore";
import type { CaptureFrameInfo } from "../api/capture";

const info = (protocol: string, frame_id: number, max_dlc = 8): CaptureFrameInfo => ({
  protocol,
  frame_id,
  max_dlc,
  bus: 0,
  is_extended: false,
  has_dlc_mismatch: false,
});

describe("setFrameInfoFromCapture", () => {
  beforeEach(() => {
    useDiscoveryFrameStore.getState().clearAll();
  });

  it("keeps the same numeric id on two protocols apart", () => {
    useDiscoveryFrameStore
      .getState()
      .setFrameInfoFromCapture([info("can", 256), info("modbus", 256)]);

    const { seenIds, frameInfoMap } = useDiscoveryFrameStore.getState();
    expect([...seenIds].sort()).toEqual(["can:256", "modbus:256"]);
    expect(frameInfoMap.get("can:256")?.protocol).toBe("can");
    expect(frameInfoMap.get("modbus:256")?.protocol).toBe("modbus");
  });

  it("does not merge the metadata of frames that share a numeric id", () => {
    useDiscoveryFrameStore
      .getState()
      .setFrameInfoFromCapture([info("can", 256, 8), info("modbus", 256, 2)]);

    const { frameInfoMap } = useDiscoveryFrameStore.getState();
    expect(frameInfoMap.get("can:256")?.len).toBe(8);
    expect(frameInfoMap.get("modbus:256")?.len).toBe(2);
  });

  it("selects everything when no selection set is active", () => {
    useDiscoveryFrameStore
      .getState()
      .setFrameInfoFromCapture([info("can", 256), info("modbus", 256)]);

    expect(useDiscoveryFrameStore.getState().selectedFrames.size).toBe(2);
  });

  it("restores only the keys an active selection set names", () => {
    useDiscoveryFrameStore
      .getState()
      .setFrameInfoFromCapture(
        [info("can", 256), info("modbus", 256)],
        new Set(["modbus:256"])
      );

    expect([...useDiscoveryFrameStore.getState().selectedFrames]).toEqual(["modbus:256"]);
  });
});
