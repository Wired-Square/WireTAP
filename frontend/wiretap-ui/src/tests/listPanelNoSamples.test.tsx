// @vitest-environment jsdom

import { describe, it, expect, vi, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));
vi.mock("../hooks/useSettings", () => ({ useSettings: () => ({ settings: null }) }));

import ListPanel from "../apps/dashboard/views/panels/list/ListPanel";
import { useDashboardStore, type DashboardPanel, type SignalRef } from "../stores/dashboardStore";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const signal = (signalName: string): SignalRef => ({ frameId: 0x100, signalName, colour: "" });

describe("the list panel", () => {
  let root: Root;
  afterEach(() => act(() => root.unmount()));

  it("a signal with no samples reads as a dash, not zero, and a real zero as zero", async () => {
    useDashboardStore.getState().pushSignalValues([{ frameId: 0x100, signalName: "Zero", value: 0, timestamp: 1 }]);
    const panel = { id: "l", type: "list", title: "", signals: [signal("Zero"), signal("Never")], minValue: 0, maxValue: 0 } as DashboardPanel;
    const host = document.createElement("div");
    root = createRoot(host);
    await act(async () => root.render(<ListPanel panel={panel} />));
    const values = [...host.querySelectorAll(".tabular-nums")].map((v) => v.textContent);
    expect(values).toEqual(["0.000", "—"]);
  });
});
