// Teardown behaviour of the Discovery frame store.
//
// The view reads rows from the module-level frame buffer and the frame-picker counts
// from Zustand state. Clearing those in two separate store writes produced a render in
// between where the rows still existed but the picker already read 0/0 — one of the
// ways a destroyed session appeared to leave data on screen.

import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../api/settings", () => ({
  tlog: { info: vi.fn(), debug: vi.fn(), verbose: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../services/memoryDiag", () => ({ trackAlloc: vi.fn() }));

import {
  useDiscoveryFrameStore,
  getDiscoveryFrameBuffer,
  getLastFrameDataMap,
} from "../stores/discoveryFrameStore";
import type { FrameMessage } from "../types/frame";

const frame = (id: number, ts: number): FrameMessage => ({
  protocol: "can",
  timestamp_us: ts,
  frame_id: id,
  bus: 0,
  dlc: 5,
  bytes: [1, 0, 0, 0, 0x7b],
  is_extended: false,
});

/** addFrames buffers on a trailing timeout — advance past it to land the flush. */
async function flush() {
  await vi.advanceTimersByTimeAsync(600);
}

describe("discoveryFrameStore teardown", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useDiscoveryFrameStore.getState().clearAll();
  });

  it("clearAll empties the buffer, the last-frame map and the picker together", async () => {
    useDiscoveryFrameStore.getState().addFrames([frame(0x100, 1), frame(0x101, 2)], 10_000);
    await flush();

    expect(getDiscoveryFrameBuffer().length).toBe(2);
    expect(getLastFrameDataMap().size).toBe(2);
    expect(useDiscoveryFrameStore.getState().seenIds.size).toBe(2);

    useDiscoveryFrameStore.getState().clearAll();

    expect(getDiscoveryFrameBuffer()).toEqual([]);
    expect(getLastFrameDataMap().size).toBe(0);
    expect(useDiscoveryFrameStore.getState().seenIds.size).toBe(0);
    expect(useDiscoveryFrameStore.getState().selectedFrames.size).toBe(0);
    expect(useDiscoveryFrameStore.getState().frameInfoMap.size).toBe(0);
    expect(useDiscoveryFrameStore.getState().streamStartTimeUs).toBeNull();
  });

  it("clearAll clears frames and picker in a single store write", async () => {
    useDiscoveryFrameStore.getState().addFrames([frame(0x100, 1)], 10_000);
    await flush();

    // Record what a subscriber would observe. If the clear were two writes, one of these
    // snapshots would show an empty buffer beside a still-populated picker.
    const observed: Array<{ buffered: number; picker: number }> = [];
    const unsub = useDiscoveryFrameStore.subscribe((s) =>
      observed.push({ buffered: getDiscoveryFrameBuffer().length, picker: s.seenIds.size }),
    );

    useDiscoveryFrameStore.getState().clearAll();
    unsub();

    expect(observed).toHaveLength(1);
    expect(observed[0]).toEqual({ buffered: 0, picker: 0 });
  });

  it("bumps frameVersion so the view recomputes after a clear", async () => {
    useDiscoveryFrameStore.getState().addFrames([frame(0x100, 1)], 10_000);
    await flush();

    const before = useDiscoveryFrameStore.getState().frameVersion;
    useDiscoveryFrameStore.getState().clearAll();
    expect(useDiscoveryFrameStore.getState().frameVersion).toBeGreaterThan(before);
  });

  it("cancels a pending flush so in-flight frames cannot repopulate the buffer", async () => {
    useDiscoveryFrameStore.getState().addFrames([frame(0x100, 1)], 10_000);
    // Clear while the batch is still pending, before the flush timeout fires.
    useDiscoveryFrameStore.getState().clearAll();
    await flush();

    expect(getDiscoveryFrameBuffer()).toEqual([]);
    expect(useDiscoveryFrameStore.getState().seenIds.size).toBe(0);
  });

  it("enableCaptureMode drops the last-frame map rather than leaking it", async () => {
    useDiscoveryFrameStore.getState().addFrames([frame(0x100, 1)], 10_000);
    await flush();
    expect(getLastFrameDataMap().size).toBe(1);

    // Capture mode hands display over to the capture; the in-memory caches must go with
    // it, or bulk-add and the MCP live frame map keep reporting the old session.
    useDiscoveryFrameStore.getState().enableCaptureMode(1);

    expect(getDiscoveryFrameBuffer()).toEqual([]);
    expect(getLastFrameDataMap().size).toBe(0);
  });
});
