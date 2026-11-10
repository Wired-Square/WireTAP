// @vitest-environment jsdom

import { describe, it, expect, vi, afterEach } from "vitest";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";

const commands = vi.hoisted(() => ({
  list_dashboards: [{ name: "Broken", filename: "broken.dashboard.json", path: "/d/broken.dashboard.json" }],
  open_dashboard: JSON.stringify({ schema: "wiretap.dashboard/0", panels: [], layout: [] }),
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: keyof typeof commands) => commands[cmd]),
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("uplot", () => ({ default: class {} }));
vi.mock("../components/AppTopBar", () => ({ default: ({ children }: { children: ReactNode }) => <>{children}</> }));

await import("../i18n");
const { default: DashboardTopBar } = await import("../apps/dashboard/views/DashboardTopBar");
const { useSessionStore } = await import("../stores/sessionStore");
const { useDashboardStore } = await import("../stores/dashboardStore");

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const noop = () => {};
const asyncNoop = async () => {};

describe("opening a dashboard file", () => {
  let root: Root;
  afterEach(() => act(() => root.unmount()));

  it("an invalid file shows why it was not opened and leaves the dashboard as it was", async () => {
    vi.spyOn(console, "error").mockImplementation(noop);
    const host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    await act(async () =>
      root.render(
        <DashboardTopBar
          ioProfile={null} ioProfiles={[]} isStreaming={false} onOpenIoSessionPicker={noop}
          catalogs={[]} catalogPath={null} onOpenCatalogPicker={noop} watchFrameCount={0}
          savedLayouts={[]} onSaveLayout={asyncNoop} onLoadLayout={noop} onDeleteLayout={asyncNoop}
          catalogFilename="" rawViewMode={false} onToggleRawView={noop}
        />,
      ),
    );
    const panelsBefore = useDashboardStore.getState().panels;

    await act(async () => document.querySelector<HTMLElement>('[title="Manage layouts"]')!.click());
    const file = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((el) => el.textContent === "Broken");
    await act(async () => file!.click());

    const dialog = useSessionStore.getState().appErrorDialog;
    expect(dialog.isOpen).toBe(true);
    expect(dialog.details).toContain("Unsupported dashboard schema");
    expect(useDashboardStore.getState().panels).toBe(panelsBefore);
  });
});
