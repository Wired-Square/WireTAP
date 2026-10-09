// A tool whose backend command fails must stop showing as running: the flag
// used to stay set, leaving the toolbox's spinner up for good.

import { describe, it, expect, vi, beforeEach } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
vi.mock("../stores/discoveryUIStore", () => ({
  useDiscoveryUIStore: { getState: () => ({ setFramesViewActiveTab: () => {} }) },
}));

import { useDiscoveryToolboxStore } from "../stores/discoveryToolboxStore";

const source = { captureId: "c1", selection: [] };

const refuse = (command: string) =>
  invoke.mockImplementation(async (cmd: string) => {
    if (cmd === command) throw new Error("capture gone");
  });

describe("a failed analysis command", () => {
  beforeEach(() => invoke.mockReset());

  it("leaves Payload Changes not running", async () => {
    refuse("payload_changes_cmd");
    const result = await useDiscoveryToolboxStore.getState().runChangesAnalysis(source);
    expect(result).toBeNull();
    expect(useDiscoveryToolboxStore.getState().toolbox.isRunning).toBe(false);
  });

  it("leaves Frame Order not running", async () => {
    refuse("frame_order_cmd");
    const result = await useDiscoveryToolboxStore.getState().runMessageOrderAnalysis(source);
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
