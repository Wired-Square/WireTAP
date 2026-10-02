// Discovery tells its own sweep from a poller before the joined session's record
// lands, by the session it started rather than by the id's spelling.

import { describe, it, expect, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("../stores/discoveryUIStore", () => ({
  useDiscoveryUIStore: { getState: () => ({ setFramesViewActiveTab: () => {} }) },
}));

import { isOwnScanSession, useDiscoveryToolboxStore } from "../stores/discoveryToolboxStore";

const toolbox = () => useDiscoveryToolboxStore.getState().toolbox;

describe("isOwnScanSession", () => {
  it("knows a sweep's session from the start, whatever its id says", () => {
    expect(isOwnScanSession(toolbox(), "f_1a2b3c")).toBe(false);
    useDiscoveryToolboxStore.getState().startModbusScan("register", "f_1a2b3c");
    expect(isOwnScanSession(toolbox(), "f_1a2b3c")).toBe(true);
    expect(isOwnScanSession(toolbox(), "m_scan_4d5e6f")).toBe(false);
  });

  it("still knows it once the sweep has finished", () => {
    useDiscoveryToolboxStore.getState().startModbusScan("unit-id", "m_scan_000001");
    useDiscoveryToolboxStore.getState().finishModbusScan();
    expect(isOwnScanSession(toolbox(), "m_scan_000001")).toBe(true);
  });
});
