// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

vi.mock("@sentry/react", () => ({ captureMessage: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
  emit: vi.fn(async () => {}),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { invoke } from "@tauri-apps/api/core";
import { useTransmitHistoryView } from "../apps/transmit/hooks/useTransmitHistoryView";
import { useSessionHistoryCount } from "../apps/transmit/hooks/useSessionHistoryCount";
import TransmitReplayView from "../apps/transmit/views/TransmitReplayView";
import { useTransmitStore, replaysInSession, type ReplayLogEntry } from "../stores/transmitStore";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const MINE = "f_slcan-1";
const AGENT = "mcp_agent-1";
const historyRow = { id: 1, session_id: MINE, timestamp_us: 10, kind: "can", frame_id: 0x100, dlc: 1, bytes: [1], bus: 0, is_extended: false, is_fd: false, success: true, error_msg: null };

const calls = (cmd: string) => vi.mocked(invoke).mock.calls.filter(([c]) => c === cmd).map(([, args]) => args);

let host: HTMLDivElement;
let root: Root;

async function render(node: React.ReactNode) {
  host = document.createElement("div");
  root = createRoot(host);
  await act(async () => root.render(node));
}

beforeEach(() => {
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockImplementation(async (cmd: string) => {
    if (cmd === "transmit_history_count") return 1;
    if (cmd === "transmit_history_query") return [historyRow];
    return null;
  });
  useTransmitStore.setState({ historyDbCount: 20017 });
});

afterEach(() => act(() => root.unmount()));

let viewResult: ReturnType<typeof useTransmitHistoryView>;
function HistoryHarness({ sessionId }: { sessionId: string | null }) {
  viewResult = useTransmitHistoryView({ pageSize: 10, sessionId });
  return null;
}

let tabCount: number;
function TabCountHarness({ sessionId }: { sessionId: string | null }) {
  tabCount = useSessionHistoryCount(sessionId);
  return null;
}

describe("Transmit history is the panel's session's", () => {
  it("the list and its count read only the panel's session", async () => {
    await render(<HistoryHarness sessionId={MINE} />);
    expect(calls("transmit_history_query")).toContainEqual({ sessionId: MINE, offset: 0, limit: 10 });
    expect(viewResult.totalCount).toBe(1);
    expect(viewResult.rows).toEqual([historyRow]);
  });

  it("a panel in no session shows no history", async () => {
    await render(<HistoryHarness sessionId={null} />);
    expect(calls("transmit_history_query")).toEqual([]);
    expect(viewResult.totalCount).toBe(0);
    expect(viewResult.rows).toEqual([]);
  });

  it("the History tab counts the panel's session, not the database", async () => {
    await render(<TabCountHarness sessionId={MINE} />);
    expect(calls("transmit_history_count")).toContainEqual({ sessionId: MINE });
    expect(tabCount).toBe(1);
  });

  it("the History tab counts nothing with no session", async () => {
    await render(<TabCountHarness sessionId={null} />);
    expect(tabCount).toBe(0);
  });
});

const progress = (sessionId: string, profileName: string) =>
  ({ totalFrames: 10, framesSent: 1, speed: 1, loopReplay: false, profileName, sessionId });
const logEntry = (replayId: string, sessionId: string, profileName: string) =>
  ({ id: replayId, replayId, sessionId, profileName, kind: "started", totalFrames: 10, speed: 1, loopReplay: false, timestamp: 0 }) as ReplayLogEntry;

describe("Transmit replays are the panel's session's", () => {
  beforeEach(() => {
    useTransmitStore.setState({
      activeReplays: new Set(["r-mine", "r-agent"]),
      replayProgress: new Map([["r-mine", progress(MINE, "my-slcan")], ["r-agent", progress(AGENT, "agent-virtual")]]),
      replayLog: [logEntry("r-mine", MINE, "my-slcan"), logEntry("r-agent", AGENT, "agent-virtual")],
    });
  });

  it("the Replay tab counts only the panel's session's replays", () => {
    expect(replaysInSession(useTransmitStore.getState(), MINE)).toEqual(["r-mine"]);
    expect(replaysInSession(useTransmitStore.getState(), null)).toEqual([]);
  });

  it("the Replay tab shows only the panel's session's replays", async () => {
    await render(<TransmitReplayView useLocalTimezone sessionId={MINE} />);
    expect(host.textContent).toContain("my-slcan");
    expect(host.textContent).not.toContain("agent-virtual");
  });

  it("a panel in no session shows no replays", async () => {
    await render(<TransmitReplayView useLocalTimezone sessionId={null} />);
    expect(host.textContent).not.toContain("my-slcan");
    expect(host.textContent).not.toContain("agent-virtual");
  });
});
