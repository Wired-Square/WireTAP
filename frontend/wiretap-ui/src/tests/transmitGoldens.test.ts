// @vitest-environment jsdom
// P5 D1: the transmit queue's rules, the serial hex parser beside `hexToBytes`,
// and the replay estimate beside `replay.rs` (`fixtures/data/replayEstimate.json`).

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@sentry/react", () => ({ captureMessage: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}), emit: vi.fn(async () => {}) }));
const invoke = vi.fn(async (..._args: unknown[]): Promise<unknown> => undefined);
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
vi.mock("../api/capture", () => ({}));
vi.mock("../utils/windowCommunication", () => ({ openPanel: vi.fn() }));

import { useSessionStore, type Session } from "../stores/sessionStore";
import { useTransmitStore, type CanEditorState, type TransmitQueueItem } from "../stores/transmitStore";
import { hexToBytes } from "../utils/byteUtils";
import { formatDuration, replayEstimateUs } from "../dialogs/ReplayDialog";
import type { ReceivedFrame, ReplayFrame, RepeatStartedEvent } from "../api/transmit";
import { expectGolden, fixtureJson, type GoldenCase } from "./catalogGoldens";

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
    activeGroups: new Set(),
    replayCache: new Map(),
    replayProgress: new Map(),
    activeReplays: new Set(),
    replayLog: [],
    error: null,
    queueRepeatIntervalMs: 1000,
  });
  store().resetCanEditor();
  store().resetSerialEditor();
}

/** Ids are minted from the clock; the snapshot numbers them by first sighting. */
function snapshot() {
  const ids = new Map<string, string>();
  const name = (id: string) => ids.get(id) ?? (ids.set(id, `#${ids.size}`), ids.get(id)!);
  const { queue, activeGroups, error, replayCache } = store();
  return {
    queue: queue.map((q: TransmitQueueItem) => ({ ...q, id: name(q.id) })),
    activeGroups: [...activeGroups],
    error,
    replayCache: Object.fromEntries(replayCache),
    queuedMarks: Object.fromEntries(
      Object.values(useSessionStore.getState().sessions).map((s) => [s.id, s.hasQueuedMessages]),
    ),
    invoked: invoke.mock.calls.map(([cmd, args]) => ({
      cmd,
      args: args && typeof args === "object" && "queueId" in args ? { ...args, queueId: name(String(args.queueId)) } : args,
    })),
  };
}

const ids = () => store().queue.map((q) => q.id);

const frame = (over: Partial<ReceivedFrame> = {}): ReceivedFrame =>
  ({ frame_id: 0x100, bytes: [1, 2, 3, 4], bus: 0, is_extended: false, dlc: 2, ...over }) as ReceivedFrame;

function addRows(groups: (string | undefined)[], sessionId = "a") {
  for (const g of groups) store().addCanFramesBulk([frame()], session(sessionId), undefined, g);
}

type Step = { name: string; input: unknown; run: () => Promise<void> | void };

const steps: Step[] = [
  { name: "addCanToQueue with no active session", input: { activeSessionId: null }, run: () => { reset(undefined, null); store().addCanToQueue(); } },
  { name: "addCanToQueue from the default editor", input: "defaults", run: () => store().addCanToQueue() },
  {
    name: "addCanToQueue with an id the editor cannot build is silently dropped",
    input: { frameId: "800" },
    run: () => { store().updateCanEditor({ frameId: "800" }); store().addCanToQueue(); },
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
    run: () => { store().updateSerialEditor({ hexInput: "zz" }); store().addSerialToQueue(); },
  },
  {
    name: "addSerialToQueue raw framing",
    input: { hexInput: "AA BB C" },
    run: () => { store().updateSerialEditor({ hexInput: "AA BB C" }); store().addSerialToQueue(); },
  },
  {
    name: "addSerialToQueue delimiter framing keeps the editor's delimiter",
    input: { hexInput: "01", framingMode: "delimiter" },
    run: () => { store().updateSerialEditor({ hexInput: "01", framingMode: "delimiter" }); store().addSerialToQueue(); },
  },
  {
    name: "toggleQueueEnabled on a repeating row stops it and clears repeating",
    input: "row 0 repeating",
    run: () => {
      addRows([undefined]);
      useTransmitStore.setState({ queue: store().queue.map((q) => ({ ...q, isRepeating: true })) });
      store().toggleQueueEnabled(ids()[0]);
    },
  },
  {
    name: "toggleQueueEnabled twice re-enables a row without restarting it",
    input: "row 0 repeating",
    run: () => {
      addRows([undefined]);
      useTransmitStore.setState({ queue: store().queue.map((q) => ({ ...q, isRepeating: true })) });
      store().toggleQueueEnabled(ids()[0]);
      store().toggleQueueEnabled(ids()[0]);
    },
  },
  {
    name: "updateQueueInterval takes any number while repeating, with no backend call",
    input: { intervalMs: -5 },
    run: () => {
      addRows([undefined]);
      useTransmitStore.setState({ queue: store().queue.map((q) => ({ ...q, isRepeating: true })) });
      store().updateQueueInterval(ids()[0], -5);
    },
  },
  {
    name: "updateQueueItemBus applies to CAN rows only",
    input: { bus: 3 },
    run: () => {
      addRows([undefined]);
      store().updateSerialEditor({ hexInput: "01" });
      store().addSerialToQueue();
      for (const id of ids()) store().updateQueueItemBus(id, 3);
    },
  },
  {
    name: "updateQueueItemSession moves a row and re-marks both sessions",
    input: { from: "a", to: "b" },
    run: () => { addRows([undefined]); store().updateQueueItemSession(ids()[0], session("b")); },
  },
  {
    name: "removeFromQueue of a repeating row stops it and unmarks an emptied session",
    input: "row 0 repeating",
    run: () => {
      addRows([undefined]);
      useTransmitStore.setState({ queue: store().queue.map((q) => ({ ...q, isRepeating: true })) });
      store().removeFromQueue(ids()[0]);
    },
  },
  {
    name: "clearQueue stops each repeating row one by one",
    input: "rows 0 and 2 repeating",
    run: async () => {
      addRows([undefined, undefined, undefined]);
      useTransmitStore.setState({ queue: store().queue.map((q, i) => ({ ...q, isRepeating: i !== 1 })) });
      await store().clearQueue();
    },
  },
  {
    name: "setItemGroup blank is none; getGroupNames sorted and unique",
    input: { groups: ["b", "a", "b", ""] },
    run: () => {
      addRows([undefined, undefined, undefined, undefined]);
      ["b", "a", "b", ""].forEach((g, i) => store().setItemGroup(ids()[i], g));
      useTransmitStore.setState({ error: JSON.stringify(store().getGroupNames()) });
    },
  },
  {
    name: "startRepeat CAN sends the row's frame and interval and marks it repeating",
    input: "row 0",
    run: async () => { addRows([undefined]); await store().startRepeat(ids()[0]); },
  },
  {
    name: "startRepeat serial falls back to raw framing",
    input: { serialFraming: undefined },
    run: async () => {
      store().updateSerialEditor({ hexInput: "0102" });
      store().addSerialToQueue();
      useTransmitStore.setState({ queue: store().queue.map((q) => ({ ...q, serialFraming: undefined })) });
      await store().startRepeat(ids()[0]);
    },
  },
  {
    name: "startRepeat on a disconnected session",
    input: { lifecycleState: "connecting" },
    run: async () => {
      reset([session("a", { lifecycleState: "connecting" })]);
      addRows([undefined]);
      await store().startRepeat(ids()[0]);
    },
  },
  {
    name: "startRepeat on a disabled row still starts",
    input: { enabled: false },
    run: async () => {
      addRows([undefined]);
      store().toggleQueueEnabled(ids()[0]);
      await store().startRepeat(ids()[0]);
    },
  },
  {
    name: "startGroupRepeat: enabled CAN rows in queue order, consecutive same-session rows merged, first row's interval",
    input: { rows: ["g a 10ms", "g b 20ms", "g a 30ms (disabled)", "g a 40ms", "h a"] },
    run: async () => {
      store().addCanFramesBulk([frame({ frame_id: 1 })], session("a"), 10, "g");
      store().addCanFramesBulk([frame({ frame_id: 2 })], session("b"), 20, "g");
      store().addCanFramesBulk([frame({ frame_id: 3 })], session("a"), 30, "g");
      store().addCanFramesBulk([frame({ frame_id: 4 })], session("a"), 40, "g");
      store().addCanFramesBulk([frame({ frame_id: 5 })], session("a"), 50, "h");
      store().toggleQueueEnabled(ids()[2]);
      await store().startGroupRepeat("g");
    },
  },
  {
    name: "startGroupRepeat then the backend's group-started event marks enabled CAN rows",
    input: "group g, one disabled",
    run: async () => {
      addRows(["g", "g"]);
      store().toggleQueueEnabled(ids()[1]);
      await store().startGroupRepeat("g");
      store().markGroupRepeating("g");
    },
  },
  {
    name: "disabling a row of a repeating group stops the row's id, not the group",
    input: "group g active",
    run: () => {
      addRows(["g", "g"]);
      store().markGroupRepeating("g");
      store().toggleQueueEnabled(ids()[0]);
    },
  },
  {
    name: "startGroupRepeat with no enabled rows",
    input: "group g all disabled",
    run: async () => { addRows(["g"]); store().toggleQueueEnabled(ids()[0]); await store().startGroupRepeat("g"); },
  },
  {
    name: "startGroupRepeat with one member's session gone",
    input: { sessions: ["a"] },
    run: async () => {
      addRows(["g"], "a");
      addRows(["g"], "gone");
      await store().startGroupRepeat("g");
    },
  },
  {
    name: "markRepeatStopped with a group name stops the group; with a row id the row",
    input: "group g active, row 2 repeating alone",
    run: () => {
      addRows(["g", "g", undefined]);
      store().markGroupRepeating("g");
      useTransmitStore.setState({ queue: store().queue.map((q, i) => (i === 2 ? { ...q, isRepeating: true } : q)) });
      store().markRepeatStopped("g");
      store().markRepeatStopped(ids()[2]);
    },
  },
  {
    name: "stopAllRepeats asks the active session only and clears every row",
    input: "rows on a and b repeating",
    run: async () => {
      addRows([undefined], "a");
      addRows([undefined], "b");
      useTransmitStore.setState({ queue: store().queue.map((q) => ({ ...q, isRepeating: true })) });
      await store().stopAllRepeats();
    },
  },
  {
    name: "stopAllGroupRepeats clears grouped rows only",
    input: "group g active, ungrouped row repeating",
    run: async () => {
      addRows(["g", undefined]);
      store().markGroupRepeating("g");
      useTransmitStore.setState({ queue: store().queue.map((q) => ({ ...q, isRepeating: true })) });
      await store().stopAllGroupRepeats();
    },
  },
  {
    name: "addExternalRepeat adds an agent row, then updates it in place",
    input: { queue_id: "agent-1", origin: "agent" },
    run: () => {
      const ev = {
        queue_id: "agent-1",
        session_id: "a",
        profile_id: "p",
        profile_name: "n",
        interval_ms: 100,
        origin: "agent",
        frame_id: 0x10,
        data: [1],
        bus: 0,
        is_extended: false,
        is_fd: false,
        is_brs: false,
        is_rtr: false,
      } as RepeatStartedEvent;
      store().addExternalRepeat(ev);
      store().setItemGroup("agent-1", "kept");
      store().addExternalRepeat({ ...ev, interval_ms: 200, session_id: "b", origin: "user" } as RepeatStartedEvent);
    },
  },
  {
    name: "startReplay caches the replay; a stop or finish never drops it; restart reuses it",
    input: { replayId: "r1", speed: 2, loop: true },
    run: async () => {
      const frames: ReplayFrame[] = [{ timestamp_us: 0, frame: { frame_id: 1, data: [1], bus: 0, is_extended: false, is_fd: false, is_brs: false, is_rtr: false } }];
      await store().startReplay("a", "r1", frames, 2, true);
      store().handleReplayLifecycle({ replay_id: "r1", session_id: "a", event: { kind: "finished" }, frames_sent: 1, total_frames: 1, speed: 2, loop_replay: true, pass: 1, pass_duration_us: 0 } as never);
      await store().restartReplay("r1");
      await store().restartReplay("unknown");
    },
  },
  {
    name: "startReplay that the backend refuses is not cached",
    input: { replayId: "r2" },
    run: async () => {
      invoke.mockImplementation(async () => { throw new Error("no session"); });
      await store().startReplay("a", "r2", [], 1, false);
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

  it("parseSerialBytes beside hexToBytes", async () => {
    const cases: GoldenCase[] = serialInputs.map((hexInput) => {
      store().updateSerialEditor({ hexInput });
      const store_ = store().parseSerialBytes();
      const shared = hexToBytes(hexInput);
      return { name: JSON.stringify(hexInput), input: hexInput, expected: { parseSerialBytes: store_, hexToBytes: shared, agree: JSON.stringify(store_) === JSON.stringify(shared) } };
    });
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

describe("replay estimate against replay.rs", () => {
  const { rows } = fixtureJson<{ rows: { name: string; timestamps_us: number[]; speed: number; ts: number }[] }>("data/replayEstimate.json");
  it.each(rows.map((row) => [row.name, row] as const))("%s", (_, row) => {
    const span = row.timestamps_us[row.timestamps_us.length - 1] - row.timestamps_us[0];
    expect(replayEstimateUs(span, row.speed)).toBe(row.ts);
  });
});
