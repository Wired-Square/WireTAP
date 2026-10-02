// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@sentry/react", () => ({ captureMessage: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
  emit: vi.fn(async () => {}),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => undefined) }));

import { useSessionStore, type Session } from "../stores/sessionStore";
import { useTransmitStore } from "../stores/transmitStore";
import type { ReplayEvent, ReplayState } from "../api/transmit";

const SESSION_ID = "f_virtual-1";

const replay = (event: ReplayEvent, pass: number, frames_sent: number): ReplayState => ({
  event,
  replay_id: "r1",
  session_id: SESSION_ID,
  frames_sent,
  total_frames: 2,
  speed: 1,
  loop_replay: true,
  pass,
  pass_duration_us: 1_500,
});

const feed = (...states: ReplayState[]) => states.forEach(useTransmitStore.getState().handleReplayLifecycle);
const logged = () => useTransmitStore.getState().replayLog.map((e) => e.kind).reverse();
const passesLogged = () =>
  useTransmitStore.getState().replayLog.filter((e) => e.kind === "loopRestarted").map((e) => e.pass);

beforeEach(() => {
  useSessionStore.setState({ sessions: { [SESSION_ID]: { id: SESSION_ID, profileName: "virtual" } as Session } });
  useTransmitStore.setState({ activeReplays: new Set(), replayProgress: new Map(), replayLog: [] });
});

describe("a looping replay's passes", () => {
  it("every completed pass is logged, across a restart", () => {
    const run = () =>
      feed(
        replay({ kind: "started" }, 1, 0),
        replay({ kind: "pass_completed" }, 1, 2),
        replay({ kind: "pass_completed" }, 2, 4),
        replay({ kind: "stopped" }, 3, 5)
      );
    run();
    run();
    expect(passesLogged()).toEqual([2, 1, 2, 1]);
  });
});

describe("a replay's events", () => {
  it("a replay the store did not start is shown and logged, named by its session", () => {
    feed(replay({ kind: "started" }, 1, 0), replay({ kind: "progress" }, 1, 1));
    const { activeReplays, replayProgress, replayLog } = useTransmitStore.getState();
    expect([...activeReplays]).toEqual(["r1"]);
    expect(replayProgress.get("r1")).toMatchObject({ framesSent: 1, profileName: "virtual", sessionId: SESSION_ID });
    expect(replayLog[0]).toMatchObject({ kind: "started", passDurationUs: 1_500 });
  });

  it("each ending is logged as what Rust says happened", () => {
    feed(replay({ kind: "started" }, 1, 0), replay({ kind: "finished" }, 1, 2));
    feed(replay({ kind: "started" }, 1, 0), replay({ kind: "failed", error: "Device disconnected" }, 1, 1));
    expect(logged()).toEqual(["started", "completed", "started", "deviceError"]);
    expect(useTransmitStore.getState().replayLog[0]).toMatchObject({ framesSent: 1, errorMessage: "Device disconnected" });
    expect(useTransmitStore.getState().activeReplays.size).toBe(0);
    expect(useTransmitStore.getState().replayProgress.size).toBe(0);
  });

  it("a progress tick logs nothing", () => {
    feed(replay({ kind: "started" }, 1, 0), replay({ kind: "progress" }, 1, 1), replay({ kind: "progress" }, 1, 2));
    expect(logged()).toEqual(["started"]);
  });
});
