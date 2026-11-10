// @vitest-environment jsdom

import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { IDockviewPanelHeaderProps } from "dockview-react";
import type { DashboardPanel } from "../stores/dashboardStore";

vi.mock("@sentry/react", () => ({ captureMessage: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()), Channel: class {} }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}), emit: vi.fn(async () => {}) }));
vi.mock("../apps/session-manager/nodes/Port", () => ({ Port: () => null }));

const { default: i18n } = await import("../i18n");
const { FALLBACK_LANGUAGE, PSEUDO_LANGUAGE } = await import("../locales");
const { useTransmitStore } = await import("../stores/transmitStore");
const { useDashboardStore } = await import("../stores/dashboardStore");
const { hasDefaultTitle, panelTitle } = await import("../apps/dashboard/widgets/widgetMeta");
const { default: AppTab } = await import("../components/AppTab");
const { appTitle } = await import("../apps/registry");
const { default: ConfirmDeleteDialog } = await import("../dialogs/ConfirmDeleteDialog");
const { CHECKSUM_ALGORITHMS } = await import("../utils/analysis/checksums");
const { candidateReasonNote } = await import("../utils/analysis/serialFrameAnalysis");
const { fileFilter } = await import("../api/dialogs");
const { ioStateLabel, describeEvent } = await import("../apps/session-manager/stores/sessionLogStore");
const { default: SourceNode } = await import("../apps/session-manager/nodes/SourceNode");
const { parseDashboard } = await import("../utils/dashboards");
const { withAppError } = await import("../utils/appError");
const { useSessionStore } = await import("../stores/sessionStore");

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const tabProps = (id: string) =>
  ({ api: { id, title: "Discovery", isActive: true, onDidActiveChange: () => ({ dispose() {} }) } }) as unknown as IDockviewPanelHeaderProps;

const dashboard = () => useDashboardStore.getState();
const panel = (id: string) => dashboard().panels.find((p) => p.id === id)!;

describe("store, dialog and shared labels", () => {
  let root: Root | undefined;

  const render = (element: ReactElement) => {
    const host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    act(() => root!.render(element));
    return document.body.textContent ?? "";
  };

  beforeEach(async () => {
    await i18n.changeLanguage(PSEUDO_LANGUAGE);
  });

  afterEach(async () => {
    act(() => root?.unmount());
    root = undefined;
    document.body.innerHTML = "";
    useTransmitStore.setState({ error: null });
    useDashboardStore.setState({ panels: [], layout: [] });
    await i18n.changeLanguage(FALLBACK_LANGUAGE);
  });

  it("translates a store error", async () => {
    await useTransmitStore.getState().sendCanFrame();
    expect(useTransmitStore.getState().error).toBe("⟦No IO session connected. Use 'Data Source' to connect.⟧");
  });

  it("names a dock tab from its panel id, not the title a saved layout kept", () => {
    expect(render(<AppTab {...tabProps("discovery")} />)).toBe("⟦Discovery⟧");
    expect(appTitle(i18n.t, "test-pattern")).toBe("⟦Test Pattern⟧");
    expect(appTitle(i18n.t, "mcp")).toBe("mcp");
  });

  it("puts the highlighted name inside one sentence", () => {
    render(<ConfirmDeleteDialog open onCancel={() => {}} onConfirm={() => {}} messageKey="catalog:deleteConfirm.canFrame" name="0x100" />);
    const body = document.querySelector("p")!;
    expect(body.textContent).toBe("⟦Are you sure you want to delete CAN frame 0x100⟧");
    expect(body.querySelector("span")?.textContent).toBe("0x100");
  });

  it("translates checksum algorithms, serial notes and file filters", () => {
    const sum8 = CHECKSUM_ALGORITHMS.find((a) => a.id === "sum8")!;
    expect([sum8.name, sum8.description]).toEqual(["⟦Sum (8-bit)⟧", "⟦Simple sum of bytes modulo 256⟧"]);
    expect(candidateReasonNote(i18n.t, { code: "deviceCount", count: 4 }, 2)).toBe("⟦4 unique 16-bit addresses (strong pattern)⟧");
    expect(fileFilter("dbc", ["dbc"]).name).toBe("⟦DBC Files⟧");
  });

  it("has an English label for every checksum algorithm", async () => {
    await i18n.changeLanguage(FALLBACK_LANGUAGE);
    const missing = CHECKSUM_ALGORITHMS.flatMap(({ id }) => [`common:checksumAlgorithms.${id}.name`, `common:checksumAlgorithms.${id}.description`]).filter((k) => !i18n.exists(k));
    expect(missing).toEqual([]);
  });

  it("keeps a new panel's title as the default, shown in the current language", () => {
    const id = dashboard().addPanel("gauge");
    expect(panel(id).title).toBe("");
    expect(panelTitle(panel(id))).toBe("⟦Gauge⟧");
    dashboard().clonePanel(id);
    expect(dashboard().panels[1].title).toBe("⟦⟦Gauge⟧ (copy)⟧");
    dashboard().addSignalToPanel(id, 0x100, "rpm");
    expect(panel(id).title).toBe("rpm");
  });

  it("treats an English default title from a saved dashboard as the default", () => {
    const saved = (title: string) => ({ id: title, type: "rotary", title, signals: [], minValue: 0, maxValue: 0 }) as DashboardPanel;
    useDashboardStore.setState({ panels: [saved("Rotary"), saved("Pump")] });
    expect(hasDefaultTitle(panel("Rotary"))).toBe(true);
    expect(panelTitle(panel("Rotary"))).toBe("⟦Rotary⟧");
    expect(panelTitle(panel("Pump"))).toBe("Pump");
    dashboard().addSignalToPanel("Rotary", 0x100, "steer");
    dashboard().addSignalToPanel("Pump", 0x100, "steer");
    expect(dashboard().panels.map((p) => p.title)).toEqual(["steer", "Pump"]);
  });

  it("names session states and source kinds in the Session Manager, keeping the ids", () => {
    expect(ioStateLabel({ type: "Starting" })).toBe("⟦starting⟧");
    expect(describeEvent({ kind: "state", state: { type: "Error", message: "port lost" } }, null)).toBe("⟦State: ⟦error: port lost⟧⟧");
    expect(describeEvent({ kind: "stats", state: { type: "Running" }, subscriber_count: 1, frame_count: 2 }, null)).toBe("⟦State: ⟦running⟧, Listeners: 1, Frames: 2⟧");
    const text = render(
      <>
        <SourceNode selected={false} data={{ profileId: "c", profileName: "Bench", sourceType: "sqlite", isRealtime: false, isActive: false, captureCount: 3, captureKind: "bytes" }} />
        <SourceNode selected={false} data={{ profileId: "v", profileName: "Sim", sourceType: "virtual", isRealtime: true, isActive: false }} />
      </>,
    );
    expect(text).toContain("⟦Capture⟧");
    expect(text).toContain("3 ⟦bytes⟧");
    expect(text).toContain("⟦Virtual");
    expect(text).not.toMatch(/sqlite|virtual/);
  });

  it("words a dashboard file's validation error in the current language", async () => {
    await withAppError("title", "message", async () => {
      parseDashboard(JSON.stringify({ schema: 99, panels: [], layout: [] }));
    });
    expect(useSessionStore.getState().appErrorDialog.details).toBe("⟦Unsupported dashboard schema: 99⟧");
  });
});
