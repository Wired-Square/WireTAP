// What the capture filter API actually sends to Rust.
//
// The over-match bug lived at this boundary: the frontend held composite keys but sent
// bare numeric ids, so `WHERE frame_id IN (…)` matched CAN 0x100 against Modbus register
// 256. Asserting the invoke payload is the cheapest place to catch that class again.

import { describe, it, expect, beforeEach, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

import {
  getCaptureFramesPaginatedFiltered,
  getCaptureFramesTail,
  findCaptureOffsetForTimestamp,
  searchCaptureFrames,
} from "../api/capture";
import { stepCaptureFrame } from "../api/io";
import { groupKeysByProtocol } from "../utils/frameKey";

/** The selection a mixed-protocol capture produces from its picker. */
const mixed = groupKeysByProtocol(new Set(["can:256", "modbus:256"]));

function lastCall(): [string, Record<string, unknown>] {
  return invoke.mock.calls[invoke.mock.calls.length - 1] as [string, Record<string, unknown>];
}

function lastPayload(): Record<string, unknown> {
  return lastCall()[1];
}

describe("capture filter arguments", () => {
  beforeEach(() => {
    invoke.mockReset();
    invoke.mockResolvedValue({});
  });

  it("sends the paginated filter grouped by protocol, not as bare ids", async () => {
    await getCaptureFramesPaginatedFiltered("c1", 0, 50, mixed);

    expect(lastCall()[0]).toBe("get_capture_frames_paginated_filtered");
    const selection = lastPayload().selection as Array<{ protocol: string; frame_ids: number[] }>;
    expect(selection).toHaveLength(2);
    expect(selection.map((g) => g.protocol).sort()).toEqual(["can", "modbus"]);
    expect(lastPayload()).not.toHaveProperty("selected_ids");
  });

  it("sends the same shape from the tail, the offset lookup and search", async () => {
    await getCaptureFramesTail("c1", 50, mixed);
    expect(lastPayload().selection).toEqual(mixed);

    await findCaptureOffsetForTimestamp("c1", 1_000, mixed);
    expect(lastPayload().selection).toEqual(mixed);

    await searchCaptureFrames("c1", "ff", true, false, mixed);
    expect(lastPayload().selection).toEqual(mixed);
  });

  it("sends the selection when stepping the capture", async () => {
    await stepCaptureFrame("s1", "c1", 0, null, false, mixed);

    expect(lastCall()[0]).toBe("step_capture_frame");
    expect(lastPayload().filter_selection).toEqual(mixed);
  });

  it("sends an empty selection as an empty list, which the backend reads as all frames", async () => {
    await getCaptureFramesPaginatedFiltered("c1", 0, 50, groupKeysByProtocol([]));

    expect(lastPayload().selection).toEqual([]);
  });
});
