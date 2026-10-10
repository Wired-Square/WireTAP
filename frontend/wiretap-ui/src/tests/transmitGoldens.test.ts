// @vitest-environment jsdom
// P5 D1, moved by D3: the Transmit queue is Rust's (`transmit_queue.rs`, whose tests pin its
// rules: sending rows refuse edits, disabled rows do not start, group members and interval),
// so the queue golden pins what the store asks Rust for and how it takes Rust's queue back.
// Serial bytes are `hexToBytes`'s; the replay estimate is `replay.rs`'s
// (`fixtures/data/replayEstimate.json`, checked there).

import { describe, it, vi, beforeEach } from "vitest";

vi.mock("@sentry/react", () => ({ captureMessage: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}), emit: vi.fn(async () => {}) }));
const invoke = vi.fn(async (..._args: unknown[]): Promise<unknown> => undefined);
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
vi.mock("../api/capture", () => ({}));
vi.mock("../utils/windowCommunication", () => ({ openPanel: vi.fn() }));

import { useSessionStore, type Session } from "../stores/sessionStore";
import { useTransmitStore, type CanEditorState } from "../stores/transmitStore";
import { hexToBytes } from "../utils/byteUtils";
import { formatDuration } from "../dialogs/ReplayDialog";
import type { QueueRow, ReceivedFrame } from "../api/transmit";
import { expectGolden, type GoldenCase } from "./catalogGoldens";

const session = (id: string, over: Partial<Session> = {}) =>
  ({
    id,
    profileId: `profile_${id}`,
    profileName: `name_${id}`,
    lifecycleState: "connected",
    hasQueuedMessages: false,
    capabilities: { traits: { tx_frames: true, tx_bytes: true } },
    ...over,
  }) as unknown as Session;

const store = () => useTransmitStore.getState();

function reset(sessions: Session[] = [session("a"), session("b")], active: string | null = "a") {
  invoke.mockReset();
  invoke.mockImplementation(async () => undefined);
  useSessionStore.setState({ sessions: Object.fromEntries(sessions.map((s) => [s.id, s])), activeSessionId: active });
  useTransmitStore.setState({
    queue: [],
    queueRevision: -1,
    activeGroups: new Set(),
    replayProgress: new Map(),
    activeReplays: new Set(),
    replayLog: [],
    error: null,
    queueRepeatIntervalMs: 1000,
  });
  store().resetCanEditor();
  store().resetSerialEditor();
}

function snapshot() {
  const { queue, queueRevision, activeGroups, error } = store();
  return {
    error,
    invoked: invoke.mock.calls.map(([cmd, args]) => ({ cmd, args })),
    queue: queue.map((q) => q.id),
    queueRevision,
    activeGroups: [...activeGroups],
    queuedMarks: Object.fromEntries(
      Object.values(useSessionStore.getState().sessions).map((s) => [s.id, s.hasQueuedMessages]),
    ),
  };
}

const frame = (over: Partial<ReceivedFrame> = {}): ReceivedFrame =>
  ({ frame_id: 0x100, bytes: [1, 2, 3, 4], bus: 0, is_extended: false, dlc: 2, ...over }) as ReceivedFrame;

const row = (id: string, sessionId: string, group: string | null = null): QueueRow => ({
  id,
  session_id: sessionId,
  profile_id: `profile_${sessionId}`,
  profile_name: `name_${sessionId}`,
  payload: { kind: "can", frame: { frame_id: 1, data: [1], bus: 0, is_extended: false, is_fd: false, is_brs: false, is_rtr: false } },
  interval_ms: 1000,
  enabled: true,
  group,
  origin: "user",
  repeating: false,
  last_error: null,
});

type Step = { name: string; input: unknown; run: () => Promise<void> | void };

const steps: Step[] = [
  { name: "addCanToQueue with no active session", input: { activeSessionId: null }, run: () => { reset(undefined, null); return store().addCanToQueue(); } },
  { name: "addCanToQueue from the default editor", input: "defaults", run: () => store().addCanToQueue() },
  {
    name: "addCanToQueue with an id the editor cannot build is silently dropped",
    input: { frameId: "800" },
    run: () => { store().updateCanEditor({ frameId: "800" }); return store().addCanToQueue(); },
  },
  {
    name: "addCanFramesBulk slices bytes to dlc, blank group is none, interval defaults to the editor's",
    input: { frames: [frame(), frame({ frame_id: 0x200, is_rtr: true, dlc: 3 } as Partial<ReceivedFrame>)], group: "" },
    run: () => store().addCanFramesBulk([frame(), frame({ frame_id: 0x200, is_rtr: true, dlc: 3 } as Partial<ReceivedFrame>)], session("b"), undefined, ""),
  },
  {
    name: "addCanFramesBulk with an interval and group",
    input: { intervalMs: 50, group: "g1" },
    run: () => store().addCanFramesBulk([frame()], session("a"), 50, "g1"),
  },
  {
    name: "addSerialToQueue with no bytes adds nothing",
    input: { hexInput: "zz" },
    run: () => { store().updateSerialEditor({ hexInput: "zz" }); return store().addSerialToQueue(); },
  },
  {
    name: "addSerialToQueue raw framing",
    input: { hexInput: "AA BB C" },
    run: () => { store().updateSerialEditor({ hexInput: "AA BB C" }); return store().addSerialToQueue(); },
  },
  {
    name: "addSerialToQueue reads separators as hexToBytes does",
    input: { hexInput: "AA-BB,CC" },
    run: () => { store().updateSerialEditor({ hexInput: "AA-BB,CC" }); return store().addSerialToQueue(); },
  },
  {
    name: "addSerialToQueue delimiter framing keeps the editor's delimiter",
    input: { hexInput: "01", framingMode: "delimiter" },
    run: () => { store().updateSerialEditor({ hexInput: "01", framingMode: "delimiter" }); return store().addSerialToQueue(); },
  },
  {
    name: "each queue action is one command",
    input: "edit, start, stop, group start and stop, stop all, remove, clear",
    run: async () => {
      await store().editQueueRow("tx-1", { enabled: false });
      await store().startRepeat("tx-1");
      await store().stopRepeat("tx-1");
      await store().startGroupRepeat("g");
      await store().stopGroupRepeat("g");
      await store().stopAllRepeats();
      await store().removeFromQueue("tx-1");
      await store().clearQueue();
    },
  },
  {
    name: "a command Rust refuses lands in error",
    input: "start refused",
    run: () => {
      invoke.mockImplementation(async () => { throw "This row is disabled"; });
      return store().startRepeat("tx-1");
    },
  },
  {
    name: "a pushed queue replaces the view and marks its sessions; an older one is ignored",
    input: "revision 2, then revision 1",
    run: () => {
      store().applyQueue({ revision: 2, rows: [row("tx-1", "a", "g"), row("tx-2", "a")], active_groups: ["g"] });
      store().applyQueue({ revision: 1, rows: [], active_groups: [] });
    },
  },
  {
    name: "getGroupNames is the queue's groups, unique and sorted",
    input: { groups: ["b", "a", "b", null] },
    run: () => {
      store().applyQueue({ revision: 1, rows: [row("1", "a", "b"), row("2", "a", "a"), row("3", "a", "b"), row("4", "a")], active_groups: [] });
      useTransmitStore.setState({ error: JSON.stringify(store().getGroupNames()) });
    },
  },
  {
    name: "a replay starts from a capture range and restarts by its id",
    input: { replayId: "r1", speed: 2, loop: true },
    run: async () => {
      await store().startReplay("a", "r1", { capture_id: "c", offset: 4, count: 10, bus: 1 }, 2, true);
      await store().restartReplay("r1");
    },
  },
];

const editorCases: { name: string; updates: Partial<CanEditorState>[] }[] = [
  { name: "defaults", updates: [] },
  { name: "dlc 12 turns FD on and pads data", updates: [{ dlc: 12 }] },
  { name: "dlc down truncates data", updates: [{ dlc: 3 }] },
  { name: "FD on clears RTR", updates: [{ isRtr: true }, { isFd: true }] },
  { name: "FD off clears BRS", updates: [{ isFd: true, isBrs: true }, { isFd: false }] },
  { name: "FD off with dlc 12 is forced back on", updates: [{ dlc: 12 }, { isFd: false }] },
  { name: "standard id 7FF builds", updates: [{ frameId: "7FF" }] },
  { name: "standard id 800 does not build", updates: [{ frameId: "800" }] },
  { name: "extended id 1FFFFFFF builds", updates: [{ frameId: "1FFFFFFF", isExtended: true }] },
  { name: "extended id 20000000 does not build", updates: [{ frameId: "20000000", isExtended: true }] },
  { name: "id with trailing junk parses its prefix", updates: [{ frameId: "12G" }] },
  { name: "id with 0x prefix", updates: [{ frameId: "0x123" }] },
  { name: "negative id builds", updates: [{ frameId: "-1" }] },
  { name: "unparseable id", updates: [{ frameId: "zz" }] },
  { name: "data longer than dlc is sliced", updates: [{ data: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] }] },
];

const serialInputs = ["", "AABB", "aa bb cc", "AABBC", "0xAA", "0xAA0xBB", "AA,BB", "A G", "AG", "GG", "aa\tbb\ncc", "AA-BB"];

describe("transmit goldens", () => {
  beforeEach(() => reset());

  it("queue rules", async () => {
    const cases: GoldenCase[] = [];
    for (const step of steps) {
      reset();
      await step.run();
      cases.push({ name: step.name, input: step.input, expected: snapshot() });
    }
    await expectGolden("transmitQueue.json", cases, "data");
  });

  it("CAN editor and buildCanFrame", async () => {
    const cases: GoldenCase[] = editorCases.map(({ name, updates }) => {
      reset();
      updates.forEach((u) => store().updateCanEditor(u));
      store().setCanDataByte(0, 0x1ff);
      store().setCanDataByte(99, 1);
      return { name, input: updates, expected: { editor: store().canEditor, frame: store().buildCanFrame() } };
    });
    await expectGolden("transmitCanEditor.json", cases, "data");
  });

  it("serial hex is read by hexToBytes", async () => {
    const cases: GoldenCase[] = serialInputs.map((hexInput) => ({
      name: JSON.stringify(hexInput),
      input: hexInput,
      expected: { hexToBytes: hexToBytes(hexInput) },
    }));
    await expectGolden("transmitSerialBytes.json", cases, "data");
  });

  it("replay estimate text", async () => {
    const cases: GoldenCase[] = [0, 999, 1_000, 999_499, 999_500, 1_000_000, 59_999_000, 60_000_000, 61_500_000, 3_600_000_000].map((us) => ({
      name: String(us),
      input: us,
      expected: formatDuration(us),
    }));
    await expectGolden("replayDuration.json", cases, "data");
  });
});
