// @vitest-environment jsdom

import { describe, it, expect, vi, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import i18n from "../i18n";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null), Channel: class {} }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}), emit: vi.fn(async () => {}) }));

import { useColumnVisibilityMenuItems } from "../apps/discovery/components/frameContextMenuItems";
import { useDiscoveryUIStore } from "../stores/discoveryUIStore";
import type { ContextMenuItem } from "../components/ContextMenu";
import { protocolLabel } from "../utils/profileTraits";
import { GVRET_BUSES } from "../stores/transmitStore";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

describe("the Discovery tables' column menu", () => {
  let root: Root;
  afterEach(() => act(() => root.unmount()));

  function columnMenu(): ContextMenuItem[] {
    let items: ContextMenuItem[] = [];
    function Probe() {
      items = useColumnVisibilityMenuItems();
      return null;
    }
    root = createRoot(document.createElement("div"));
    act(() => root.render(<Probe />));
    return items;
  }

  it("names the four columns and toggles the one it names", () => {
    const items = columnMenu();
    expect(items.map((i) => i.label)).toEqual(["# Column", "Bus Column", "ASCII Column", "Source Column"]);

    const before = useDiscoveryUIStore.getState().showSourceColumn;
    act(() => items[3].onClick());
    expect(useDiscoveryUIStore.getState().showSourceColumn).toBe(!before);
  });
});

describe("shared labels", () => {
  it("keeps the CAN protocol tokens literal and translates the prose names", () => {
    expect(["can", "canfd", "serial", "modbus", "modbus_rtu", "lin"].map(protocolLabel)).toEqual(
      ["CAN", "CAN-FD", "Serial", "Modbus", "Modbus RTU", "lin"],
    );
  });

  it("spells every GVRET bus option from the one bus key", () => {
    expect(GVRET_BUSES.map((bus) => i18n.t("common:busNumber", { bus }))).toEqual(["Bus 0", "Bus 1", "Bus 2", "Bus 3", "Bus 4"]);
  });
});
