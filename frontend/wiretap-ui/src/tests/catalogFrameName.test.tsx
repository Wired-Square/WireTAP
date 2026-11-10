// @vitest-environment jsdom

import { describe, it, expect, vi, afterEach } from "vitest";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import "../i18n";

vi.mock("../api/catalog", () => ({ frameLayout: vi.fn(async () => null) }));

import { catalogToTree } from "../apps/catalog/tree/catalogToTree";
import { createRenderTreeNode } from "../apps/catalog/tree/renderTreeNode";
import CANFrameView from "../apps/catalog/views/CANFrameView";
import type { Catalog, Frame } from "../types/catalogModel";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const noop = () => {};
const frame = { key: "0x103", frameId: 0x103, protocol: "can", name: "BatteryStatus", length: 8, signals: [] } as Frame;
const [, frameSection] = catalogToTree({ meta: { name: "c", version: 1 }, frames: [frame] } as unknown as Catalog);
const frameNode = frameSection.children![0].children![0];

describe("a CAN frame's name in the Catalogue Editor", () => {
  let root: Root;
  afterEach(() => act(() => root.unmount()));

  const textOf = async (element: ReactNode) => {
    const host = document.createElement("div");
    root = createRoot(host);
    await act(async () => root.render(element));
    return host.textContent ?? "";
  };

  it("shows in the tree row", async () => {
    const render = createRenderTreeNode({
      expandedNodes: new Set(),
      selectedNode: null,
      onNodeClick: noop,
      onToggleExpand: noop,
    });
    expect(await textOf(render(frameNode))).toContain("BatteryStatus");
  });

  it("shows in the frame's detail view", async () => {
    const view = (
      <CANFrameView
        selectedNode={frameNode}
        editingSignal={false}
        onAddSignal={noop}
        onEditSignal={noop}
        onRequestDeleteSignal={noop}
        onAddMux={noop}
      />
    );
    expect(await textOf(view)).toContain("BatteryStatus");
  });
});
