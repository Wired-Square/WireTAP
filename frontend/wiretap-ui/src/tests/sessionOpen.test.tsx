// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import type { OpenedSession } from "../api/io";

vi.mock("@sentry/react", () => ({ captureMessage: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
  emit: vi.fn(async () => {}),
}));

let reply: (args: { session_id: string; subscriber_id: string }) => OpenedSession | Promise<OpenedSession>;
const invoke = vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
  if (cmd === "open_session") return reply(args as { session_id: string; subscriber_id: string });
  if (cmd === "unregister_session_subscriber") return 0;
  return null;
});
vi.mock("@tauri-apps/api/core", () => ({ invoke, Channel: class {} }));
vi.mock("../utils/subscriberId", () => ({ subscriberIdFor: (appName: string) => `dashboard_${appName}` }));

const { useSessionStore } = await import("../stores/sessionStore");
const { useIOSession } = await import("../hooks/useIOSession");
const { isSessionNotFound } = await import("../api/io");

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const opened = (overrides: Partial<OpenedSession> = {}): OpenedSession => ({
  created: true,
  start_error: null,
  startup_error: null,
  bus_mappings: null,
  capabilities: { traits: { temporal_mode: "realtime" } } as OpenedSession["capabilities"],
  state: { type: "Running" },
  capture_id: null,
  capture_kind: null,
  subscriber_count: 1,
  origin_profile_ids: ["p-dev"],
  source_type: "multi_source",
  source_kind: "device",
  mode: "live",
  ...overrides,
});

const sessionCommands = () =>
  invoke.mock.calls.map(([cmd]) => cmd).filter((cmd) => cmd !== "log_frontend" && !cmd.startsWith("plugin:"));
const open = () => useSessionStore.getState().openSession("p-dev", "Bench", "discovery_1", "discovery", { sessionId: "f_open" });

beforeEach(() => {
  invoke.mockClear();
  reply = () => opened();
  useSessionStore.setState({ sessions: {}, _eventListeners: {} });
  useSessionStore.getState().closeAppError();
});

describe("opening a session", () => {
  it("is one call, and the store records what Rust reports", async () => {
    await open();

    expect(sessionCommands().filter((c) => c !== "log")).toEqual(["open_session"]);
    expect(invoke.mock.calls[0][1]).toMatchObject({ session_id: "f_open", subscriber_id: "discovery_1", opts: { source_id: "p-dev" } });
    const session = useSessionStore.getState().sessions.f_open;
    expect(session).toMatchObject({ lifecycleState: "connected", ioState: "running", sourceKind: "device", subscriberCount: 1 });
  });

  it("joins a live session without resetting what it has counted", async () => {
    await open();
    useSessionStore.setState((s) => ({ sessions: { ...s.sessions, f_open: { ...s.sessions.f_open, frameCount: 40 } } }));
    reply = () => opened({ created: false, subscriber_count: 2 });

    await open();

    expect(useSessionStore.getState().sessions.f_open).toMatchObject({ frameCount: 40, subscriberCount: 2 });
  });

  it("shows a start the open could not make, and the session reads as errored", async () => {
    const refused = "33333 bit/s is not an SLCAN rate; it takes 10000, 20000";
    reply = () => opened({ start_error: refused, state: { type: "Error", message: refused } });

    await open();

    expect(useSessionStore.getState().appErrorDialog).toMatchObject({ isOpen: true, details: refused });
    expect(useSessionStore.getState().sessions.f_open).toMatchObject({ ioState: "error", errorMessage: refused });
  });

  it("refuses an id with nothing behind it as not found, and keeps nothing for it", async () => {
    invoke.mockImplementationOnce(async () => {
      throw { kind: "not_found", message: "No session 'f_open'" };
    });

    const refusal = await open().catch((e: unknown) => e);

    expect(isSessionNotFound(refusal)).toBe(true);
    expect(useSessionStore.getState().sessions.f_open).toBeUndefined();
    expect(useSessionStore.getState()._eventListeners.f_open).toBeUndefined();
  });
});

describe("a view on a session", () => {
  function View() {
    useIOSession({ appName: "discovery", sessionId: "f_view" });
    return null;
  }

  it("opens one session through a StrictMode double mount, and leaves it on unmount", async () => {
    const root = createRoot(document.body.appendChild(document.createElement("div")));
    await act(async () =>
      root.render(
        <StrictMode>
          <View />
        </StrictMode>
      )
    );
    await act(async () => {});

    const opens = invoke.mock.calls.filter(([cmd]) => cmd === "open_session");
    expect(new Set(opens.map(([, args]) => args!.subscriber_id)).size).toBe(1);
    expect(sessionCommands()).not.toContain("unregister_session_subscriber");
    expect(useSessionStore.getState().sessions.f_view?.lifecycleState).toBe("connected");

    await act(async () => root.unmount());
    await act(async () => {});
    expect(invoke.mock.calls.filter(([cmd]) => cmd === "unregister_session_subscriber")).toHaveLength(1);
  });
});
