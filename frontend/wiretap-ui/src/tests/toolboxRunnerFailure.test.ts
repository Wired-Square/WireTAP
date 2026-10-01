// A tool whose backend command fails must stop showing as running: the flag
// used to stay set, leaving the toolbox's spinner up for good.

import { describe, it, expect, vi, beforeEach } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
vi.mock("../stores/discoveryUIStore", () => ({
  useDiscoveryUIStore: { getState: () => ({ setFramesViewActiveTab: () => {} }) },
}));

import { useDiscoveryToolboxStore } from "../stores/discoveryToolboxStore";
import type { FrameMessage } from "../types/frame";

const frames: FrameMessage[] = [{ protocol: "can", timestamp_us: 0, frame_id: 0x100, bus: 0, dlc: 1, bytes: [1], is_extended: false, is_fd: false }];

const refuse = (command: string) =>
  invoke.mockImplementation(async (cmd: string) => {
    if (cmd === command) throw new Error("capture gone");
  });

describe("a failed analysis command", () => {
  beforeEach(() => invoke.mockReset());

  it("leaves Payload Changes not running", async () => {
    refuse("profile_bytes_cmd");
    const result = await useDiscoveryToolboxStore.getState().runChangesAnalysis(frames, new Map());
    expect(result).toBeNull();
    expect(useDiscoveryToolboxStore.getState().toolbox.isRunning).toBe(false);
  });

  it("leaves checksum discovery not running", async () => {
    refuse("discover_checksums_in_capture_cmd");
    const result = await useDiscoveryToolboxStore
      .getState()
      .runChecksumDiscoveryAnalysis({ captureId: "c1", selection: [] });
    expect(result).toBeNull();
    expect(useDiscoveryToolboxStore.getState().toolbox.isRunning).toBe(false);
  });
});
