// @vitest-environment jsdom

import { describe, it, expect, vi, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));
vi.mock("../hooks/useSettings", () => ({ useSettings: () => ({ settings: null }) }));
vi.mock("uplot", () => ({ default: class {} }));

import DashboardGrid from "../apps/dashboard/views/DashboardGrid";
import { useDashboardStore, type DashboardPanel } from "../stores/dashboardStore";

const observers: { callback: ResizeObserverCallback; nodes: Element[] }[] = [];

Object.assign(globalThis, {
  IS_REACT_ACT_ENVIRONMENT: true,
  requestAnimationFrame: (run: FrameRequestCallback) => {
    run(0);
    return 0;
  },
  ResizeObserver: class {
    nodes: Element[] = [];
    constructor(callback: ResizeObserverCallback) {
      observers.push({ callback, nodes: this.nodes });
    }
    observe(node: Element) {
      this.nodes.push(node);
    }
    disconnect() {
      this.nodes.length = 0;
    }
  },
});

describe("the dashboard grid", () => {
  let root: Root;
  afterEach(() => act(() => root.unmount()));

  it("follows its container's width when the first panel arrives after it opened", async () => {
    useDashboardStore.setState({ panels: [], layout: [] });
    const host = document.createElement("div");
    root = createRoot(host);
    await act(async () => root.render(<DashboardGrid onOpenPanelConfig={() => {}} />));

    const panel = { id: "p", type: "list", title: "", signals: [], minValue: 0, maxValue: 100 } as DashboardPanel;
    await act(async () => useDashboardStore.setState({ panels: [panel], layout: [{ i: "p", x: 0, y: 0, w: 12, h: 4 }] }));

    const grid = host.firstElementChild!;
    await act(async () => {
      for (const { callback, nodes } of observers) {
        for (const node of nodes) {
          if (node === grid) callback([{ contentRect: { width: 1200 } } as ResizeObserverEntry], {} as ResizeObserver);
        }
      }
    });

    const item = host.querySelector<HTMLElement>('[data-panel-id="p"]');
    expect(item?.style.width).toBe("1184px");
  });
});
