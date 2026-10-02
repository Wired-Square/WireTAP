// @vitest-environment jsdom
// The Rust half is `the_session_log_records_a_sessions_life_where_it_happens` in io/session.rs.
// `fixtures/session-log/old-subscription.json` is what the deleted TypeScript subscription
// logged for the same scripted sequence.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import golden from "./fixtures/session-log/old-subscription.json";
import type { SessionLogEntry } from "../generated/SessionLogEntry";
import type { SessionLogEvent } from "../generated/SessionLogEvent";

let ring: SessionLogEntry[] = [];
const invoke = vi.fn(async (cmd: string, args?: { after_id: number | null }) => {
  if (cmd !== "get_session_log") return null;
  return ring.filter((e) => e.id > (args?.after_id ?? 0));
});
vi.mock("@tauri-apps/api/core", () => ({ invoke, Channel: class {} }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}), emit: vi.fn(async () => {}) }));

const { useSessionLogStore, describeEntry, displayKind, profileNames } = await import(
  "../apps/session-manager/stores/sessionLogStore"
);
const { useSessionLogSync } = await import("../apps/session-manager/hooks/useSessionLogSync");
const { wsTransport } = await import("../services/wsTransport");
const { MsgType, HEADER_SIZE, PROTOCOL_VERSION } = await import("../services/wsProtocol");

let nextId = 1;
const entry = (event: SessionLogEvent, over: Partial<SessionLogEntry> = {}): SessionLogEntry => ({
  id: nextId++,
  timestamp_ms: 1_700_000_000_000,
  session_id: "f_1",
  profile_ids: ["p1"],
  subscriber_id: null,
  app_name: null,
  event,
  ...over,
});

/** A `SessionLogAppended` message as `ws::dispatch::session_log_message` frames it. */
function wsMessage(e: SessionLogEntry): ArrayBuffer {
  const json = new TextEncoder().encode(JSON.stringify(e));
  const buf = new Uint8Array(HEADER_SIZE + json.length);
  buf.set([PROTOCOL_VERSION << 4, MsgType.SessionLogAppended, 0, 0]);
  buf.set(json, HEADER_SIZE);
  return buf.buffer;
}

const pushes = new Map<number, (raw: ArrayBuffer) => void>();
let reconnect: () => void = () => {};
vi.spyOn(wsTransport, "onGlobalMessage").mockImplementation((msgType, handler) => {
  pushes.set(msgType, (raw) => handler(new DataView(raw, HEADER_SIZE), raw));
  return () => {};
});
vi.spyOn(wsTransport, "onReconnect").mockImplementation((handler) => {
  reconnect = handler;
  return () => {};
});

const settle = () => act(async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); });

beforeEach(() => {
  ring = [];
  nextId = 1;
  useSessionLogStore.setState({ entries: [] });
});

describe("the session log view's copy of the Rust ring", () => {
  it("reads the ring on mount, takes each push, and reads on after a reconnect", async () => {
    ring = [entry({ kind: "reconfigured" }), entry({ kind: "capture_changed" })];
    const root = createRoot(document.createElement("div"));
    await act(async () => root.render(createElement(() => (useSessionLogSync(), null))));
    await settle();
    expect(useSessionLogStore.getState().entries.map((e) => e.id)).toEqual([1, 2]);

    const pushed = entry({ kind: "state", state: { type: "Running" } });
    ring.push(pushed);
    act(() => pushes.get(MsgType.SessionLogAppended)!(wsMessage(pushed)));
    expect(useSessionLogStore.getState().entries[2]).toEqual(pushed);

    ring.push(entry({ kind: "speed", speed: 2 }), entry({ kind: "reconfigured" }));
    invoke.mockClear();
    reconnect();
    await settle();
    expect(invoke).toHaveBeenCalledWith("get_session_log", { after_id: 3 });
    expect(useSessionLogStore.getState().entries.map((e) => e.id)).toEqual([1, 2, 3, 4, 5]);
    root.unmount();
  });

  it("ignores an entry it already holds and drops everything before a clear", () => {
    const { ingest } = useSessionLogStore.getState();
    const first = entry({ kind: "reconfigured" });
    ingest([first, entry({ kind: "capture_changed" })]);
    ingest([first]);
    expect(useSessionLogStore.getState().entries).toHaveLength(2);
    const cleared = entry({ kind: "cleared" }, { session_id: null, profile_ids: [] });
    ingest([cleared, entry({ kind: "reconfigured" })]);
    expect(useSessionLogStore.getState().entries.map((e) => e.event.kind)).toEqual(["cleared", "reconfigured"]);
  });
});

const OLD_KIND: Record<string, string> = {
  "session-created": "created",
  "session-joined": "joined",
  "session-left": "left",
  "session-destroyed": "destroyed",
  "state-change": "state",
  "stream-ended": "stream_ended",
  "stream-complete": "stream_complete",
  "session-error": "error",
  "session-reconfigured": "reconfigured",
  "buffer-changed": "capture_changed",
  "device-connected": "device_connected",
  "device-probe": "device_probe",
  "mcp-connected": "mcp_connected",
  "mcp-disconnected": "mcp_disconnected",
};

describe("the ring's entries against the old subscription's golden", () => {
  it("render the same rows, apart from the named differences", () => {
    const probe = { session_id: null, subscriber_id: null };
    const typed = [
      entry({ kind: "created", mode: "live", subscriber_count: 1 }, { subscriber_id: "discovery_1", app_name: "discovery_1" }),
      entry({ kind: "joined", subscriber_count: 2 }, { subscriber_id: "decoder_1", app_name: "decoder" }),
      entry({ kind: "state", state: { type: "Running" } }),
      entry({ kind: "left", subscriber_count: 1 }, { subscriber_id: "decoder_1" }),
      entry({ kind: "transitioned", transition: "switched_to_capture", mode: "replaying" }),
      entry({ kind: "reconfigured" }),
      entry({ kind: "capture_changed" }),
      entry({ kind: "device_connected", source_type: "gvret_tcp", address: "10.0.0.2:23", bus: 0 }),
      entry({ kind: "error", message: "Device unplugged" }),
      entry({ kind: "stream_ended", reason: "disconnected", capture_count: 12 }),
      entry({ kind: "stream_ended", reason: "paused", capture_count: 12 }),
      entry({ kind: "device_probe", source_type: "gvret_tcp", address: "10.0.0.2:23", success: true, cached: false, bus_count: 2, error: null }, probe),
      entry({ kind: "device_probe", source_type: "gvret_tcp", address: "10.0.0.2:23", success: false, cached: true, bus_count: 0, error: "timed out" }, probe),
      entry({ kind: "mcp_connected", client: "abcdef123456" }, { session_id: null, profile_ids: [], app_name: "mcp" }),
      entry({ kind: "mcp_disconnected", client: "abcdef123456" }, { session_id: null, profile_ids: [], app_name: "mcp" }),
      entry({ kind: "destroyed", reset: false }),
    ];
    const profiles = [{ id: "p1", name: "Bench GVRET" }];
    const rendered = typed.map((e) => ({
      kind: displayKind(e.event),
      sessionId: e.session_id,
      profileName: profileNames(e, profiles),
      details: describeEntry(e),
    }));
    const old = golden.map((g) => ({ kind: OLD_KIND[g.eventType], sessionId: g.sessionId, profileName: g.profileName, details: g.details }));

    // The creator's join is the created entry's subscriber, not a second row.
    const [created, creatorJoined, ...rest] = old;
    expect(creatorJoined.details).toBe("discovery_1 joined (1 listeners)");
    const expected = [created, ...rest].map((row) => {
      switch (row.details) {
        // A join or leave names who, and counts in the singular when it is one.
        case "Listener joined (2 listeners)":
          return { ...row, details: "decoder joined (2 listeners)" };
        case "Listener left (1 listeners)":
          return { ...row, details: "decoder_1 left (1 listener)" };
        // A transition says which, where the old signal only said something happened.
        case "Session lifecycle event (state refreshed)":
          return { ...row, kind: "transitioned", details: "Switched to capture (Replaying)" };
        case "Session buffers changed":
          return { ...row, details: "Session captures changed" };
        default:
          // A probe is about a profile, not a session.
          return row.kind === "device_probe" ? { ...row, sessionId: null } : row;
      }
    });
    expect(rendered).toEqual(expected);
  });
});
