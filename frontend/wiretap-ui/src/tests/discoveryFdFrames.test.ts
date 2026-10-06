import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../api/settings", () => ({
  tlog: { info: vi.fn(), debug: vi.fn(), verbose: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../services/memoryDiag", () => ({ trackAlloc: vi.fn() }));

import { useDiscoveryFrameStore } from "../stores/discoveryFrameStore";
import { decodeFrameBatch, ENVELOPE_HEADER_SIZE, FrameType } from "../services/wsProtocol";
import { groupKeysByProtocol } from "../utils/frameKey";

function canEnvelope(frameType: number, id: number, payloadLen: number): ArrayBuffer {
  const buf = new ArrayBuffer(ENVELOPE_HEADER_SIZE + 4 + payloadLen);
  const view = new DataView(buf);
  view.setUint8(9, frameType);
  view.setUint32(11, 4 + payloadLen, true);
  view.setUint32(ENVELOPE_HEADER_SIZE, id, true);
  return buf;
}

describe("CAN FD frames in Discovery", () => {
  beforeEach(() => {
    useDiscoveryFrameStore.getState().clearAll();
  });

  // The capture stores an FD frame as protocol "can" with is_fd set, and filters the
  // CAN table on the picker's keys, so a live key under any other protocol hides it.
  it("an FD frame reaches Discovery's CAN table", () => {
    const frames = [
      ...decodeFrameBatch(canEnvelope(FrameType.Can, 0x123, 8), 0),
      ...decodeFrameBatch(canEnvelope(FrameType.CanFd, 0x125, 16), 0),
    ];
    vi.useFakeTimers();
    useDiscoveryFrameStore.getState().addFrames(frames, 1000);
    vi.runAllTimers();
    vi.useRealTimers();

    const selection = groupKeysByProtocol(useDiscoveryFrameStore.getState().selectedFrames);
    expect(selection).toEqual([{ protocol: "can", frame_ids: [0x123, 0x125] }]);
  });
});
