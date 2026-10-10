// @vitest-environment jsdom

import { describe, it, expect, vi, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { UseIOSessionManagerOptions } from "../hooks/useIOSessionManager";

const invoke = vi.fn(async (_cmd: string, _args?: unknown) => null);
vi.mock("@tauri-apps/api/core", () => ({ invoke, Channel: class {} }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
  emit: vi.fn(async () => {}),
}));
vi.mock("../hooks/useMenuSessionControl", () => ({ useMenuSessionControl: () => {} }));
vi.mock("../hooks/useAllIOProfiles", () => ({ useAllIOProfiles: () => [] }));
vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });

let managerOptions: UseIOSessionManagerOptions | undefined;
const manager = new Proxy(
  {
    multiBusProfiles: [],
    outputBusToSource: new Map(),
    effectiveSessionId: null,
    session: { sessionId: null, state: "stopped", isReady: false, start: vi.fn(), stop: vi.fn(), leave: vi.fn() },
    capabilities: null,
    joinerCount: 0,
  } as Record<PropertyKey, unknown>,
  { get: (target, key) => (key in target ? target[key] : vi.fn()) },
);
vi.mock("../hooks/useIOSessionManager", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../hooks/useIOSessionManager")>()),
  useIOSessionManager: (options: UseIOSessionManagerOptions) => {
    managerOptions = options;
    return manager;
  },
}));

const { default: Transmit } = await import("../apps/transmit/Transmit");

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

describe("Transmit re-pointing its session", () => {
  let root: Root;
  afterEach(() => act(() => root.unmount()));

  it("stops no repeat on watch, join or leave", async () => {
    root = createRoot(document.body.appendChild(document.createElement("div")));
    await act(async () => root.render(<Transmit />));

    await act(async () => {
      managerOptions!.onBeforeWatch?.();
      managerOptions!.onBeforeMultiWatch?.();
    });

    const stops = invoke.mock.calls.filter(([cmd]) => cmd.startsWith("transmit_queue_stop") || cmd === "transmit_group_stop");
    expect(stops).toEqual([]);
  });
});
