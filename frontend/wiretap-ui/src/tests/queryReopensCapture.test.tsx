// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";

const rust = vi.hoisted(() => ({
  captures: new Map<string, string>(),
  sessions: new Map<string, { captureId: string; subscribers: Set<string> }>(),
  minted: 0,
}));

const invoke = vi.hoisted(() =>
  vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
    if (cmd === "open_session") {
      const { session_id, subscriber_id, opts } = args as {
        session_id: string | null;
        subscriber_id: string;
        opts: { source_id?: string };
      };
      let id = session_id;
      if (!id) {
        const source = opts.source_id!;
        if (!rust.captures.has(source)) throw { kind: "sessionNotFound", message: `No capture '${source}'` };
        id = [...rust.sessions].find(([, s]) => s.captureId === source)?.[0] ?? `c_${++rust.minted}`;
        if (!rust.sessions.has(id)) rust.sessions.set(id, { captureId: source, subscribers: new Set() });
      }
      const session = rust.sessions.get(id);
      if (!session) throw { kind: "sessionNotFound", message: `No session '${id}'` };
      session.subscribers.add(subscriber_id);
      return {
        session_id: id,
        created: false,
        start_error: null,
        startup_error: null,
        bus_mappings: null,
        capabilities: { traits: { temporal_mode: "capture", protocols: ["can"] }, available_buses: [0] },
        state: { type: "Stopped" },
        capture_id: session.captureId,
        capture_kind: "frames",
        subscriber_count: session.subscribers.size,
        origin_profile_ids: [session.captureId],
        source_type: "capture",
        source_kind: "capture",
        mode: "capture",
      };
    }
    if (cmd === "unregister_session_subscriber") {
      const { session_id, subscriber_id } = args as { session_id: string; subscriber_id: string };
      const session = rust.sessions.get(session_id);
      session?.subscribers.delete(subscriber_id);
      if (session && session.subscribers.size === 0) rust.sessions.delete(session_id);
      return session?.subscribers.size ?? 0;
    }
    if (cmd === "get_capture_metadata_by_id") {
      const id = (args as { capture_id: string }).capture_id;
      const name = rust.captures.get(id);
      return name ? { id, name, kind: "frames", count: 10, persistent: false, buses: [] } : null;
    }
    return null;
  }),
);
vi.mock("@tauri-apps/api/core", () => ({ invoke, Channel: class {} }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}), emit: vi.fn(async () => {}) }));
vi.mock("../utils/subscriberId", () => ({ subscriberIdFor: (appName: string) => `main_${appName}` }));
vi.mock("../hooks/useMenuSessionControl", () => ({ useMenuSessionControl: () => {} }));
vi.mock("../hooks/useAllIOProfiles", () => ({ useAllIOProfiles: () => [] }));
vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });

const { default: Query } = await import("../apps/query/Query");
const { useQueryStore } = await import("../apps/query/stores/queryStore");

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 20)));

async function openQueryTab() {
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  await act(async () => root.render(<Query />));
  await settle();
  return {
    host,
    close: async () => {
      await act(async () => root.unmount());
      await settle();
      host.remove();
    },
  };
}

describe("reopening the Query tab", () => {
  beforeEach(() => {
    rust.captures = new Map([["cap_1", "Bench run"]]);
    rust.sessions = new Map([["c_1", { captureId: "cap_1", subscribers: new Set() }]]);
    useQueryStore.setState({ ioProfile: "c_1" });
  });

  it("reopens the capture whose session its own close destroyed", async () => {
    const first = await openQueryTab();
    expect(first.host.textContent).toContain("Bench run");
    await first.close();
    expect(rust.sessions.has("c_1")).toBe(false);

    const reopened = await openQueryTab();
    expect(reopened.host.textContent).toContain("Bench run");
    expect(reopened.host.textContent).not.toContain("c_1");
    await reopened.close();
  });

  it("drops a capture deleted while the tab was closed, leaving no source", async () => {
    const first = await openQueryTab();
    expect(first.host.textContent).toContain("Bench run");
    await first.close();
    rust.captures.delete("cap_1");

    const reopened = await openQueryTab();
    expect(useQueryStore.getState().ioProfile).toBeNull();
    expect(reopened.host.textContent).not.toContain("c_1");
    await reopened.close();
  });
});
