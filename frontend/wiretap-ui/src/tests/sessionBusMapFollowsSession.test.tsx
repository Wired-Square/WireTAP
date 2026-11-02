// @vitest-environment jsdom

import { describe, it, expect, vi, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null), Channel: class {} }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}), emit: vi.fn(async () => {}) }));

const session = {
  subscriberId: "sub",
  sessionId: undefined,
  state: "stopped",
  capabilities: null,
  isReady: true,
  joinerCount: 1,
  rejoin: vi.fn(async (id: string | null, sourceId?: string) => id ?? `s_${sourceId}`),
  reinitialize: vi.fn(async () => {}),
  leave: vi.fn(async () => {}),
};
vi.mock("../hooks/useIOSession", () => ({ useIOSession: () => session }));

vi.mock("../stores/sessionStore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../stores/sessionStore")>()),
  createAndStartMultiSourceSession: vi.fn(async () => ({
    sessionId: "f_multi",
    busMappings: new Map([
      ["can_a", [{ device_bus: 0, output_bus: 0, enabled: true }]],
      ["can_b", [{ device_bus: 0, output_bus: 1, enabled: true }]],
    ]),
  })),
}));

vi.mock("../api/io", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/io")>()),
  generateSessionId: vi.fn(async () => "f_generated"),
}));

vi.mock("../stores/profileBusStore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../stores/profileBusStore")>()),
  useProfileBusStore: { getState: () => ({ ensureLoaded: async () => {} }) },
  isMultiSourceCapable: (p: { kind: string }) => p.kind === "gs_usb",
}));

const { useIOSessionManager } = await import("../hooks/useIOSessionManager");
type Manager = ReturnType<typeof useIOSessionManager>;

const profiles = [
  { id: "can_a", name: "CAN A", kind: "gs_usb", connection: {} },
  { id: "can_b", name: "CAN B", kind: "gs_usb", connection: {} },
  { id: "dump", name: "Dump", kind: "csv_file", connection: {} },
] as never[];

let root: Root | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
});

async function mountManager(): Promise<{ current: Manager }> {
  const ref = {} as { current: Manager };
  function Probe() {
    ref.current = useIOSessionManager({ appName: "discovery", ioProfiles: profiles });
    return null;
  }
  root = createRoot(document.createElement("div"));
  await act(async () => root!.render(<Probe />));
  await act(async () => ref.current.watchSource(["can_a", "can_b"], {}));
  expect(ref.current.outputBusToSource.size).toBe(2);
  return ref;
}

describe("a window's bus map belongs to the session it was built for", () => {
  it("is empty after selecting a single profile", async () => {
    const manager = await mountManager();
    await act(async () => manager.current.selectProfile("dump"));
    expect([...manager.current.outputBusToSource.keys()]).toEqual([]);
  });

  it("is empty after joining another session", async () => {
    const manager = await mountManager();
    await act(async () => manager.current.joinSession("f_other"));
    expect([...manager.current.outputBusToSource.keys()]).toEqual([]);
  });
});
