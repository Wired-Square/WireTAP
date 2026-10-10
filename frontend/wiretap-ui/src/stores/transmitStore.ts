// ui/src/stores/transmitStore.ts
//
// Zustand store for the Transmit app: the editors, the replay log and a view of
// the Transmit queue, which is Rust's process state (`transmit_queue.rs`) pushed
// to every window over WS.

import { create } from "zustand";
import {
  type CanTransmitFrame,
  type NewQueueRow,
  type QueuePayload,
  type QueueRow,
  type QueueRowEdit,
  type ReceivedFrame,
  type ReplaySource,
  type ReplayState,
  type SerialFramingMode,
  type TransmitProfile,
  type TransmitQueue,
  type TransmitResult,
  addToTransmitQueue,
  clearTransmitQueue,
  editQueueRow,
  getTransmitCapableProfiles,
  ioRestartReplay,
  ioStartReplay,
  ioStopReplay,
  ioTransmitCanFrame,
  removeQueueRow,
  serialFraming,
  startQueueGroup,
  startQueueRow,
  stopAllQueueRepeats,
  stopQueueGroup,
  stopQueueRow,
  toTransmitFrame,
} from "../api/transmit";
import { hexToBytes } from "../utils/byteUtils";

import { useSessionStore, type Session } from "./sessionStore";

import { CAN_FD_DLC_VALUES } from "../constants";

// ============================================================================
// Types
// ============================================================================

/** Active tab in the transmit UI */
export type TransmitTab = "frame" | "queue" | "history" | "replay";

/** Re-export CAN_FD_DLC_VALUES for backwards compatibility */
export { CAN_FD_DLC_VALUES };
export type CanFdDlc = (typeof CAN_FD_DLC_VALUES)[number];

/** GVRET bus types - generic names since bus meanings vary by device */
export const GVRET_BUSES = [
  { value: 0, label: "Bus 0" },
  { value: 1, label: "Bus 1" },
  { value: 2, label: "Bus 2" },
  { value: 3, label: "Bus 3" },
  { value: 4, label: "Bus 4" },
] as const;

/** Progress info for an active replay */
export interface ReplayProgressInfo {
  totalFrames: number;
  framesSent: number;
  speed: number;
  loopReplay: boolean;
  profileName: string;
  sessionId: string;
}

/** Kind of replay log entry */
export type ReplayLogKind = "started" | "completed" | "stoppedByUser" | "deviceError" | "loopRestarted";

/** Log entry for a replay lifecycle event (start / complete / stop / error) */
export interface ReplayLogEntry {
  /** Unique entry ID */
  id: string;
  /** Replay ID this entry relates to */
  replayId: string;
  /** Session the replay transmits through */
  sessionId: string;
  /** Profile/session name */
  profileName: string;
  /** Total frames in the replay */
  totalFrames: number;
  /** Playback speed multiplier */
  speed: number;
  /** Whether the replay was set to loop */
  loopReplay: boolean;
  /** When this entry was created (ms since epoch) */
  timestamp: number;
  /** Lifecycle kind */
  kind: ReplayLogKind;
  /** Frames sent (for completed/stoppedByUser/deviceError/loopRestarted) */
  framesSent?: number;
  /** Error message (for deviceError) */
  errorMessage?: string;
  /** Loop pass number that just completed (for loopRestarted) */
  pass?: number;
  /** How long one pass takes (for started) */
  passDurationUs?: number;
}

/** CAN frame editor state */
export interface CanEditorState {
  /** Frame ID as hex string (e.g., "123" or "12345678") */
  frameId: string;
  /** Data Length Code */
  dlc: number;
  /** Frame data bytes */
  data: number[];
  /** Bus number for multi-bus writers */
  bus: number;
  /** Extended (29-bit) frame ID */
  isExtended: boolean;
  /** CAN FD frame */
  isFd: boolean;
  /** Bit Rate Switch (CAN FD only) */
  isBrs: boolean;
  /** Remote Transmission Request */
  isRtr: boolean;
}

/** Serial bytes editor state */
export interface SerialEditorState {
  /** Hex input string (e.g., "AABBCCDD") */
  hexInput: string;
  /** Framing mode */
  framingMode: SerialFramingMode;
  /** Delimiter bytes (for delimiter framing) */
  delimiter: number[];
}


// ============================================================================
// Store
// ============================================================================

type QueueRowSession = Pick<Session, "id" | "profileId" | "profileName">;

export interface TransmitState {
  // ---- Data ----
  /** Available transmit-capable profiles */
  profiles: TransmitProfile[];
  /** The process's Transmit queue, as Rust last pushed it */
  queue: QueueRow[];
  /** The revision of `queue`; an older push is ignored */
  queueRevision: number;
  /** Groups repeating now */
  activeGroups: Set<string>;
  /** Changes on every transmit history write or clear (the TransmitUpdated signal) */
  historyRevision: number;

  // ---- UI ----
  /** Active tab */
  activeTab: TransmitTab;
  /** Loading state */
  isLoading: boolean;
  /** Error message */
  error: string | null;

  // ---- CAN Editor ----
  canEditor: CanEditorState;

  // ---- Serial Editor ----
  serialEditor: SerialEditorState;

  // ---- Queue Editor ----
  /** Repeat interval for new queue items */
  queueRepeatIntervalMs: number;

  // ---- Actions ----
  /** Load available transmit profiles */
  loadProfiles: () => Promise<void>;
  /** Set active tab */
  setActiveTab: (tab: TransmitTab) => void;

  // CAN Editor Actions
  /** Update CAN editor field */
  updateCanEditor: (updates: Partial<CanEditorState>) => void;
  /** Set CAN data byte at index */
  setCanDataByte: (index: number, value: number) => void;
  /** Reset CAN editor to defaults */
  resetCanEditor: () => void;
  /** Build CAN frame from editor state */
  buildCanFrame: () => CanTransmitFrame | null;
  /** Send CAN frame once */
  sendCanFrame: () => Promise<TransmitResult | null>;

  // Serial Editor Actions
  /** Update serial editor field */
  updateSerialEditor: (updates: Partial<SerialEditorState>) => void;
  /** Reset serial editor to defaults */
  resetSerialEditor: () => void;

  // Queue Actions — each asks Rust, which pushes the changed queue to every window
  /** Take a queue Rust pushed or answered, unless an newer one is held */
  applyQueue: (queue: TransmitQueue) => void;
  /** Add the editor's CAN frame to the queue */
  addCanToQueue: () => Promise<void>;
  /** Add received CAN frames to the queue (bulk, from Discovery) */
  addCanFramesBulk: (frames: ReceivedFrame[], session: QueueRowSession, intervalMs?: number, groupName?: string) => Promise<void>;
  /** Add the editor's serial bytes to the queue */
  addSerialToQueue: () => Promise<void>;
  /** Change a row; Rust refuses one that is sending */
  editQueueRow: (queueId: string, edit: QueueRowEdit) => Promise<void>;
  removeFromQueue: (queueId: string) => Promise<void>;
  clearQueue: () => Promise<void>;
  startRepeat: (queueId: string) => Promise<void>;
  stopRepeat: (queueId: string) => Promise<void>;
  /** Stop every repeat and group in the queue */
  stopAllRepeats: () => Promise<void>;
  /** Start a group: its enabled CAN rows in queue order, every interval of the first */
  startGroupRepeat: (groupName: string) => Promise<void>;
  stopGroupRepeat: (groupName: string) => Promise<void>;
  /** Unique group names in the queue, sorted */
  getGroupNames: () => string[];

  // Replay Actions
  /** Active replay IDs */
  activeReplays: Set<string>;
  /** Progress info per active replay */
  replayProgress: Map<string, ReplayProgressInfo>;
  /** Replay lifecycle log (started/completed/stopped/error entries) */
  replayLog: ReplayLogEntry[];
  /** Start a time-accurate replay of a capture range */
  startReplay: (sessionId: string, replayId: string, source: ReplaySource, speed: number, loop: boolean) => Promise<void>;
  /** Stop a specific replay */
  stopReplay: (replayId: string) => Promise<void>;
  /** Play a replay again with what it was started with */
  restartReplay: (replayId: string) => Promise<void>;
  /** Applies a replay's `ReplayState` push: its progress, its log and whether it is active */
  handleReplayLifecycle: (state: ReplayState) => void;
  /** Clear the session's replay log */
  clearReplayLog: (sessionId: string) => void;

  // Error handling
  /** Clear error */
  clearError: () => void;
}

/** The session's active replay ids; none without a session. */
export function replaysInSession(
  state: Pick<TransmitState, "activeReplays" | "replayProgress">,
  sessionId: string | null | undefined
): string[] {
  if (!sessionId) return [];
  return [...state.activeReplays].filter((id) => state.replayProgress.get(id)?.sessionId === sessionId);
}

const DEFAULT_CAN_EDITOR: CanEditorState = {
  frameId: "123",
  dlc: 8,
  data: [0, 0, 0, 0, 0, 0, 0, 0],
  bus: 0,
  isExtended: false,
  isFd: false,
  isBrs: false,
  isRtr: false,
};

const DEFAULT_SERIAL_EDITOR: SerialEditorState = {
  hexInput: "",
  framingMode: "raw",
  delimiter: [0x0d, 0x0a], // CRLF default
};

/** Helper to get the active session from sessionStore */
const getActiveSession = () => {
  const { activeSessionId, sessions } = useSessionStore.getState();
  return activeSessionId ? sessions[activeSessionId] : null;
};

const mintId = (prefix: string) => `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;

const TERMINAL_LOG_KIND = { finished: "completed", stopped: "stoppedByUser", failed: "deviceError" } as const;

const NO_SESSION = "No IO session connected. Use 'Data Source' to connect.";

function syncQueuedMarks(queue: QueueRow[], sessionIds: Iterable<string>) {
  const { setHasQueuedMessages } = useSessionStore.getState();
  for (const id of new Set(sessionIds)) {
    setHasQueuedMessages(id, queue.some((q) => q.session_id === id));
  }
}

const newRow = (session: QueueRowSession, payload: QueuePayload, intervalMs: number, group?: string): NewQueueRow => ({
  session_id: session.id,
  profile_id: session.profileId,
  profile_name: session.profileName,
  payload,
  interval_ms: intervalMs,
  group: group || null,
});

/** Awaits a backend call, putting its refusal in the store's `error`. */
async function reporting(call: Promise<unknown>) {
  try {
    await call;
  } catch (e) {
    useTransmitStore.setState({ error: String(e) });
  }
}

export const useTransmitStore = create<TransmitState>((set, get) => ({
  // ---- Initial State ----
  profiles: [],
  queue: [],
  queueRevision: -1,
  activeGroups: new Set(),
  historyRevision: 0,
  activeReplays: new Set(),
  replayProgress: new Map(),
  replayLog: [],
  activeTab: "frame",
  isLoading: false,
  error: null,
  canEditor: { ...DEFAULT_CAN_EDITOR },
  serialEditor: { ...DEFAULT_SERIAL_EDITOR },
  queueRepeatIntervalMs: 1000,

  // ---- Actions ----
  loadProfiles: async () => {
    set({ isLoading: true, error: null });
    try {
      const profiles = await getTransmitCapableProfiles();
      set({ profiles, isLoading: false });
    } catch (e) {
      set({ error: String(e), isLoading: false });
    }
  },

  setActiveTab: (tab) => set({ activeTab: tab }),

  // CAN Editor Actions
  updateCanEditor: (updates) => {
    const state = get();
    const newEditor = { ...state.canEditor, ...updates };

    // Adjust data array size when DLC changes
    if (updates.dlc !== undefined) {
      const newDlc = updates.dlc;
      if (newEditor.data.length < newDlc) {
        // Extend with zeros
        newEditor.data = [
          ...newEditor.data,
          ...Array(newDlc - newEditor.data.length).fill(0),
        ];
      } else if (newEditor.data.length > newDlc) {
        // Truncate
        newEditor.data = newEditor.data.slice(0, newDlc);
      }
    }

    if (newEditor.dlc > 8) newEditor.isFd = true;
    if (newEditor.isFd) {
      newEditor.isRtr = false;
    } else {
      newEditor.isBrs = false;
    }

    set({ canEditor: newEditor });
  },

  setCanDataByte: (index, value) => {
    const state = get();
    const data = [...state.canEditor.data];
    if (index >= 0 && index < data.length) {
      data[index] = value & 0xff;
      set({ canEditor: { ...state.canEditor, data } });
    }
  },

  resetCanEditor: () => set({ canEditor: { ...DEFAULT_CAN_EDITOR } }),

  buildCanFrame: () => {
    const state = get();
    const { canEditor } = state;

    // Parse frame ID from hex string
    const frameId = parseInt(canEditor.frameId, 16);
    if (isNaN(frameId)) {
      return null;
    }

    // Validate frame ID range
    if (canEditor.isExtended) {
      if (frameId > 0x1fffffff) return null;
    } else {
      if (frameId > 0x7ff) return null;
    }

    return {
      frame_id: frameId,
      data: canEditor.data.slice(0, canEditor.dlc),
      bus: canEditor.bus,
      is_extended: canEditor.isExtended,
      is_fd: canEditor.isFd,
      is_brs: canEditor.isBrs,
      is_rtr: canEditor.isRtr,
    };
  },

  sendCanFrame: async () => {
    const session = getActiveSession();

    if (!session) {
      set({ error: "No IO session connected. Use 'Data Source' to connect." });
      return null;
    }

    if (!session.capabilities?.traits.tx_frames) {
      set({ error: "IO session does not support transmit" });
      return null;
    }

    const frame = get().buildCanFrame();
    if (!frame) {
      set({ error: "Invalid CAN frame" });
      return null;
    }

    try {
      const result = await ioTransmitCanFrame(session.id, frame);
      return result;
    } catch (e) {
      set({ error: String(e) });
      return null;
    }
  },

  // Serial Editor Actions
  updateSerialEditor: (updates) => {
    set((state) => ({
      serialEditor: { ...state.serialEditor, ...updates },
    }));
  },

  resetSerialEditor: () => set({ serialEditor: { ...DEFAULT_SERIAL_EDITOR } }),

  // Queue Actions
  applyQueue: ({ revision, rows, active_groups }) => {
    const held = get();
    if (revision <= held.queueRevision) return;
    set({ queue: rows, queueRevision: revision, activeGroups: new Set(active_groups) });
    syncQueuedMarks(rows, [...held.queue, ...rows].map((q) => q.session_id));
  },

  addCanToQueue: async () => {
    const session = getActiveSession();
    if (!session) return set({ error: NO_SESSION });
    const frame = get().buildCanFrame();
    if (!frame) return;
    await reporting(addToTransmitQueue([newRow(session, { kind: "can", frame }, get().queueRepeatIntervalMs)]));
  },

  addCanFramesBulk: (frames, session, intervalMs, groupName) => {
    const interval = intervalMs ?? get().queueRepeatIntervalMs;
    const rows = frames.map((f) =>
      newRow(session, { kind: "can", frame: toTransmitFrame({ ...f, bytes: f.bytes.slice(0, f.dlc) }) }, interval, groupName)
    );
    return reporting(addToTransmitQueue(rows));
  },

  addSerialToQueue: async () => {
    const session = getActiveSession();
    if (!session) return set({ error: NO_SESSION });
    const { serialEditor, queueRepeatIntervalMs } = get();
    const bytes = hexToBytes(serialEditor.hexInput);
    if (bytes.length === 0) return;
    const framing = serialFraming(serialEditor.framingMode, serialEditor.delimiter);
    await reporting(addToTransmitQueue([newRow(session, { kind: "serial", bytes, framing }, queueRepeatIntervalMs)]));
  },

  editQueueRow: (queueId, edit) => reporting(editQueueRow(queueId, edit)),
  removeFromQueue: (queueId) => reporting(removeQueueRow(queueId)),
  clearQueue: () => reporting(clearTransmitQueue()),
  startRepeat: (queueId) => reporting(startQueueRow(queueId)),
  stopRepeat: (queueId) => reporting(stopQueueRow(queueId)),
  stopAllRepeats: () => reporting(stopAllQueueRepeats()),
  startGroupRepeat: (groupName) => reporting(startQueueGroup(groupName)),
  stopGroupRepeat: (groupName) => reporting(stopQueueGroup(groupName)),

  getGroupNames: () => [...new Set(get().queue.flatMap((q) => (q.group ? [q.group] : [])))].sort(),

  // Replay Actions
  startReplay: (sessionId, replayId, source, speed, loop) =>
    reporting(ioStartReplay(sessionId, replayId, source, speed, loop)),

  stopReplay: (replayId) => reporting(ioStopReplay(replayId)),

  handleReplayLifecycle: (replayState) => {
    const { replay_id: replayId, session_id: sessionId, event, frames_sent: framesSent, total_frames: totalFrames, speed, loop_replay: loopReplay, pass } = replayState;
    set((state) => {
      const existing = state.replayProgress.get(replayId);
      const profileName = existing?.profileName ?? useSessionStore.getState().sessions[sessionId]?.profileName ?? "";
      const replayProgress = new Map(state.replayProgress);
      const activeReplays = new Set(state.activeReplays);
      const log = (kind: ReplayLogKind, detail: Partial<ReplayLogEntry>) => [
        { id: mintId("replay"), replayId, sessionId, profileName, totalFrames, speed, loopReplay, timestamp: Date.now(), kind, ...detail },
        ...state.replayLog,
      ];

      switch (event.kind) {
        case "started":
          replayProgress.set(replayId, { totalFrames, framesSent, speed, loopReplay, profileName, sessionId });
          activeReplays.add(replayId);
          return { activeReplays, replayProgress, replayLog: log("started", { passDurationUs: replayState.pass_duration_us }) };
        case "progress":
          if (existing) replayProgress.set(replayId, { ...existing, framesSent });
          return { replayProgress };
        case "pass_completed":
          if (existing) replayProgress.set(replayId, { ...existing, framesSent });
          return { replayProgress, replayLog: log("loopRestarted", { framesSent, pass }) };
        default:
          replayProgress.delete(replayId);
          activeReplays.delete(replayId);
          return {
            activeReplays,
            replayProgress,
            replayLog: log(TERMINAL_LOG_KIND[event.kind], {
              framesSent,
              errorMessage: event.kind === "failed" ? event.error : undefined,
            }),
          };
      }
    });
  },

  restartReplay: (replayId) => reporting(ioRestartReplay(replayId)),

  clearReplayLog: (sessionId) =>
    set((state) => ({ replayLog: state.replayLog.filter((e) => e.sessionId !== sessionId) })),

  // Error handling
  clearError: () => set({ error: null }),
}));
