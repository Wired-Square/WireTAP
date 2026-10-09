// Teardown behaviour of the Discovery frame store.
//
// Clearing the picker in two separate store writes produced a render in between where
// the rows still existed but the picker already read 0/0 — one of the ways a destroyed
// session appeared to leave data on screen.

import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../api/settings", () => ({
  tlog: { info: vi.fn(), debug: vi.fn(), verbose: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { useDiscoveryFrameStore } from "../stores/discoveryFrameStore";
import type { CaptureFrameInfo } from "../api/capture";
import type { FrameMessage } from "../types/frame";

const row = (frame_id: number): CaptureFrameInfo => ({
  protocol: "can",
  frame_id,
  max_dlc: 8,
  bus: 0,
  is_extended: false,
  has_dlc_mismatch: false,
});

const frame = (ts: number): FrameMessage => ({
  protocol: "can",
  timestamp_us: ts,
  frame_id: 0x100,
  bus: 0,
  dlc: 0,
  bytes: [],
  is_extended: false,
  is_fd: false,
  is_rtr: false,
  is_brs: false,
  is_esi: false,
});

describe("discoveryFrameStore teardown", () => {
  beforeEach(() => {
    useDiscoveryFrameStore.getState().clearAll();
  });

  it("clearAll empties the picker and the stream clock", () => {
    useDiscoveryFrameStore.getState().mergeFrameInfo([row(0x100), row(0x101)]);
    useDiscoveryFrameStore.getState().noteStreamStart([frame(5), frame(3)]);
    expect(useDiscoveryFrameStore.getState().streamStartTimeUs).toBe(3);

    useDiscoveryFrameStore.getState().clearAll();

    const s = useDiscoveryFrameStore.getState();
    expect([s.seenIds.size, s.selectedFrames.size, s.frameInfoMap.size]).toEqual([0, 0, 0]);
    expect(s.streamStartTimeUs).toBeNull();
  });

  it("clearAll is a single store write", () => {
    useDiscoveryFrameStore.getState().mergeFrameInfo([row(0x100)]);

    const observed: number[] = [];
    const unsub = useDiscoveryFrameStore.subscribe((s) => observed.push(s.seenIds.size));
    useDiscoveryFrameStore.getState().clearAll();
    unsub();

    expect(observed).toEqual([0]);
  });

  it("bumps frameVersion so capture readers refetch after a clear", () => {
    const before = useDiscoveryFrameStore.getState().frameVersion;
    useDiscoveryFrameStore.getState().clearAll();
    expect(useDiscoveryFrameStore.getState().frameVersion).toBeGreaterThan(before);
  });

  it("keeps the first stream start it is given", () => {
    useDiscoveryFrameStore.getState().noteStreamStart([frame(10)]);
    useDiscoveryFrameStore.getState().noteStreamStart([frame(1)]);
    expect(useDiscoveryFrameStore.getState().streamStartTimeUs).toBe(10);
  });
});
