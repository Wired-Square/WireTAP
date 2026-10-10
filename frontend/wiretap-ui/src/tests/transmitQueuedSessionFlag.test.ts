// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@sentry/react", () => ({ captureMessage: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
  emit: vi.fn(async () => {}),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => undefined) }));
vi.mock("../api/capture", () => ({ renameCapture: vi.fn(async () => {}) }));

import { useSessionStore, type Session } from "../stores/sessionStore";
import { useTransmitStore } from "../stores/transmitStore";
import type { QueueRow } from "../api/transmit";

const SESSION_ID = "f_slcan-uuid-1";
const PROFILE_ID = "io_slcan";

const realtimeSession = {
  id: SESSION_ID,
  profileId: PROFILE_ID,
  profileName: "slcan",
  lifecycleState: "connected",
  hasQueuedMessages: false,
  capture: { id: "cap-1", name: "old" },
  capabilities: { traits: { tx_frames: true } },
} as unknown as Session;

const row = (id: string, sessionId = SESSION_ID): QueueRow => ({
  id,
  session_id: sessionId,
  profile_id: PROFILE_ID,
  profile_name: "slcan",
  payload: { kind: "can", frame: { frame_id: 0x100, data: [1], bus: 0, is_extended: false, is_fd: false, is_brs: false, is_rtr: false } },
  interval_ms: 1000,
  enabled: true,
  group: null,
  origin: "user",
  repeating: false,
  last_error: null,
});

let revision = 0;
const pushed = (...rows: QueueRow[]) =>
  useTransmitStore.getState().applyQueue({ revision: ++revision, rows, active_groups: [] });

beforeEach(() => {
  useSessionStore.setState({ sessions: { [SESSION_ID]: realtimeSession }, activeSessionId: SESSION_ID });
  useTransmitStore.setState({ queue: [], queueRevision: -1 });
  revision = 0;
});

describe("a queued transmit row marks its session", () => {
  it("a pushed row marks the realtime session, not an entry keyed by its profile", () => {
    pushed(row("tx-1"));
    const { sessions } = useSessionStore.getState();
    expect(Object.keys(sessions)).toEqual([SESSION_ID]);
    expect(sessions[SESSION_ID].hasQueuedMessages).toBe(true);
  });

  it("a push without the session's last row clears its mark", () => {
    pushed(row("tx-1"));
    pushed();
    expect(useSessionStore.getState().sessions[SESSION_ID].hasQueuedMessages).toBe(false);
  });

  it("a row moved to another session moves the mark with it", () => {
    const next = { ...realtimeSession, id: "f_slcan-uuid-2" } as Session;
    useSessionStore.setState((s) => ({ sessions: { ...s.sessions, [next.id]: next } }));
    pushed(row("tx-1"));
    pushed(row("tx-1", next.id));
    const { sessions } = useSessionStore.getState();
    expect(sessions[next.id].hasQueuedMessages).toBe(true);
    expect(sessions[SESSION_ID].hasQueuedMessages).toBe(false);
  });

  it("an older push than the one held is ignored", () => {
    pushed(row("tx-1"), row("tx-2"));
    useTransmitStore.getState().applyQueue({ revision: 1, rows: [], active_groups: [] });
    expect(useTransmitStore.getState().queue.map((q) => q.id)).toEqual(["tx-1", "tx-2"]);
  });

  it("a session's capture can be renamed after a row is queued", async () => {
    pushed(row("tx-1"));
    await useSessionStore.getState().renameSessionCapture("cap-1", "new");
    expect(useSessionStore.getState().sessions[SESSION_ID].capture.name).toBe("new");
  });

  it("marking an unknown session creates no entry", () => {
    useSessionStore.getState().setHasQueuedMessages("io_unknown", true);
    expect(Object.keys(useSessionStore.getState().sessions)).toEqual([SESSION_ID]);
  });
});
