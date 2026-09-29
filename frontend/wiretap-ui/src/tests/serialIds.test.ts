import { describe, it, expect, beforeEach, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

import { withSerialIds } from "../stores/discoverySerialStore";
import type { FrameMessage } from "../types/frame";

const frame = (bytes: number[], frame_id: number, source_address?: number): FrameMessage =>
  ({ protocol: "serial", timestamp_us: 0, frame_id, bus: 0, dlc: bytes.length, bytes, source_address });

describe("withSerialIds", () => {
  beforeEach(() => invoke.mockReset());

  it("asks the backend for the ids, in its config shape", async () => {
    invoke.mockResolvedValue([{ frame_id: 0x3412, source_address: 0x56 }]);
    const [out] = await withSerialIds(
      [frame([0x12, 0x34, 0x56], 0)],
      { startByte: 0, numBytes: 2, endianness: "little" },
      { startByte: -1, numBytes: 1, endianness: "big" },
    );
    expect(invoke).toHaveBeenCalledWith("extract_serial_ids", {
      frames: [[0x12, 0x34, 0x56]],
      frame_id_config: { start_byte: 0, num_bytes: 2, big_endian: false },
      source_address_config: { start_byte: -1, num_bytes: 1, big_endian: true },
    });
    expect(out).toMatchObject({ frame_id: 0x3412, source_address: 0x56 });
  });

  it("keeps a frame's own id when it is too short for the field, and drops its source", async () => {
    invoke.mockResolvedValue([{ frame_id: null, source_address: null }]);
    const [out] = await withSerialIds(
      [frame([0x12], 7, 9)],
      { startByte: 0, numBytes: 2, endianness: "big" },
      { startByte: 1, numBytes: 1, endianness: "big" },
    );
    expect(out.frame_id).toBe(7);
    expect(out.source_address).toBeUndefined();
  });

  it("leaves a field with no config alone, and skips the call with neither", async () => {
    invoke.mockResolvedValue([{ frame_id: 0x12, source_address: null }]);
    const [out] = await withSerialIds([frame([0x12], 7, 9)], { startByte: 0, numBytes: 1, endianness: "big" }, null);
    expect(out).toMatchObject({ frame_id: 0x12, source_address: 9 });

    invoke.mockClear();
    await withSerialIds([frame([0x12], 7)], null, null);
    expect(invoke).not.toHaveBeenCalled();
  });
});
