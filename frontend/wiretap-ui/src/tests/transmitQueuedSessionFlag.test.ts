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
import type { RepeatStartedEvent } from "../api/transmit";

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

const bulkFrame = { frame_id: 0x100, bytes: [1, 2], bus: 0, is_extended: false, dlc: 2 };

beforeEach(() => {
  useSessionStore.setState({ sessions: { [SESSION_ID]: realtimeSession }, activeSessionId: SESSION_ID });
  useTransmitStore.setState({ queue: [] });
});

describe("a queued transmit row marks its session", () => {
  it("queuing a frame marks the realtime session, not an entry keyed by its profile", () => {
    useTransmitStore.getState().addCanToQueue();
    const { sessions } = useSessionStore.getState();
    expect(Object.keys(sessions)).toEqual([SESSION_ID]);
    expect(sessions[SESSION_ID].hasQueuedMessages).toBe(true);
  });

  it("bulk-added rows and an agent's repeat mark the session they transmit through", () => {
    useTransmitStore.getState().addCanFramesBulk([bulkFrame], realtimeSession);
    expect(useSessionStore.getState().sessions[SESSION_ID].hasQueuedMessages).toBe(true);

    useSessionStore.getState().setHasQueuedMessages(SESSION_ID, false);
    useTransmitStore.getState().addExternalRepeat({
      queue_id: "agent-1",
      session_id: SESSION_ID,
      profile_id: PROFILE_ID,
      profile_name: "slcan",
      frame_id: 0x200,
      data: [0],
      bus: 0,
      is_extended: false,
      is_fd: false,
      interval_ms: 100,
      origin: "agent",
    } as RepeatStartedEvent);
    const { sessions } = useSessionStore.getState();
    expect(Object.keys(sessions)).toEqual([SESSION_ID]);
    expect(sessions[SESSION_ID].hasQueuedMessages).toBe(true);
  });

  it("removing the session's last row clears its mark", () => {
    useTransmitStore.getState().addCanToQueue();
    const [row] = useTransmitStore.getState().queue;
    useTransmitStore.getState().removeFromQueue(row.id);
    expect(useSessionStore.getState().sessions[SESSION_ID].hasQueuedMessages).toBe(false);
  });

  it("reassigning an orphaned row moves it, and its mark, to the new session", () => {
    useTransmitStore.getState().addCanToQueue();
    const [row] = useTransmitStore.getState().queue;
    const next = { ...realtimeSession, id: "f_slcan-uuid-2" } as Session;
    useSessionStore.setState((s) => ({
      sessions: {
        [SESSION_ID]: { ...s.sessions[SESSION_ID], lifecycleState: "disconnected" },
        [next.id]: next,
      },
    }));
    useTransmitStore.getState().updateQueueItemSession(row.id, next);
    const { sessions } = useSessionStore.getState();
    expect(useTransmitStore.getState().queue[0].sessionId).toBe(next.id);
    expect(sessions[next.id].hasQueuedMessages).toBe(true);
    expect(sessions[SESSION_ID].hasQueuedMessages).toBe(false);
  });

  it("a session's capture can be renamed after a row is queued", async () => {
    useTransmitStore.getState().addCanToQueue();
    await useSessionStore.getState().renameSessionCapture("cap-1", "new");
    expect(useSessionStore.getState().sessions[SESSION_ID].capture.name).toBe("new");
  });

  it("marking an unknown session creates no entry", () => {
    useSessionStore.getState().setHasQueuedMessages("io_unknown", true);
    expect(Object.keys(useSessionStore.getState().sessions)).toEqual([SESSION_ID]);
  });
});
