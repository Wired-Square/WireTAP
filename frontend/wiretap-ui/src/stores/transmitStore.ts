// ui/src/stores/transmitStore.ts
//
// Zustand store for Transmit app state management.
// Handles CAN/Serial transmission, queue management, and history tracking.
// Uses sessionStore for IO session management.

import { create } from "zustand";
import {
  type CanTransmitFrame,
  type TransmitProfile,
  type TransmitResult,
  type ReplayFrame,
  type ReplayState,
  type RepeatGroupMember,
  type RepeatStartedEvent,
  type SerialFraming,
  type SerialFramingMode,
  getTransmitCapableProfiles,
  // IO session-based transmit
  ioTransmitCanFrame,
  ioStartRepeatTransmit,
  ioStartSerialRepeatTransmit,
  serialFraming,
  ioStopRepeatTransmit,
  ioStopAllRepeats,
  // IO session group repeat
  ioStartRepeatGroup,
  ioStopRepeatGroup,
  ioStopAllGroupRepeats,
  // Replay
  ioStartReplay,
  ioStopReplay,
  toTransmitFrame,
} from "../api/transmit";

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

/** Queue item for repeat transmit */
export interface TransmitQueueItem {
  /** Unique ID for this queue item */
  id: string;
  /** Profile ID to use for transmission */
  profileId: string;
  /** Display name for the profile */
  profileName: string;
  /** Type of transmission */
  type: "can" | "serial";
  /** CAN frame (if type is 'can') */
  canFrame?: CanTransmitFrame;
  /** Serial payload before framing (if type is 'serial') */
  serialBytes?: number[];
  /** How the backend frames `serialBytes` (if type is 'serial') */
  serialFraming?: SerialFraming;
  /** Repeat interval in milliseconds (0 = single shot) */
  repeatIntervalMs: number;
  /** Whether this item is currently repeating */
  isRepeating: boolean;
  /** Whether this item is enabled */
  enabled: boolean;
  /** Group name for grouped repeat (items with same group are sent together in sequence) */
  groupName?: string;
  /** Who added this item. `"agent"` rows come from an MCP client, not the UI. */
  origin?: "user" | "agent";
  /** The backend session this row transmits through */
  sessionId: string;
}

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

// IOSessionConnection type removed - now using sessionStore for session management

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

export interface TransmitState {
  // ---- Data ----
  /** Available transmit-capable profiles */
  profiles: TransmitProfile[];
  // NOTE: IO session is now managed by sessionStore, accessed via useSessionStore
  /** Transmit queue */
  queue: TransmitQueueItem[];
  /** Count of rows in the SQLite transmit history (updated by transmit-history-updated event) */
  historyDbCount: number;
  /** Active group repeats (group names currently repeating) */
  activeGroups: Set<string>;

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
  /** Clean up on unmount */
  cleanup: () => Promise<void>;

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
  /** Parse hex input to bytes */
  parseSerialBytes: () => number[];

  // Queue Actions
  /** Add current CAN frame to queue */
  addCanToQueue: () => void;
  /** Add multiple CAN frames to queue (bulk, from Discovery) */
  addCanFramesBulk: (frames: Array<{ frame_id: number; bytes: number[]; bus: number; is_extended: boolean; dlc: number }>, session: QueueRowSession, intervalMs?: number, groupName?: string) => void;
  /** Add current serial bytes to queue */
  addSerialToQueue: () => void;
  /** Remove item from queue */
  removeFromQueue: (queueId: string) => void;
  /** Clear entire queue */
  clearQueue: () => void;
  /** Start repeat for queue item */
  startRepeat: (queueId: string) => Promise<void>;
  /** Stop repeat for queue item */
  stopRepeat: (queueId: string) => Promise<void>;
  /** Mark a row or group stopped (called by backend event, no API call needed) */
  markRepeatStopped: (queueId: string) => void;
  /** Mark a group repeating (called by the backend's group-started event) */
  markGroupRepeating: (groupName: string) => void;
  /** Upsert a queue item for a repeat started outside the UI (e.g. an MCP agent) */
  addExternalRepeat: (ev: RepeatStartedEvent) => void;
  /** Stop all repeats */
  stopAllRepeats: () => Promise<void>;
  /** Update queue item repeat interval */
  updateQueueInterval: (queueId: string, intervalMs: number) => void;
  /** Toggle queue item enabled state */
  toggleQueueEnabled: (queueId: string) => void;
  /** Update queue item bus (CAN only) */
  updateQueueItemBus: (queueId: string, bus: number) => void;
  /** Reassign queue item to a different session */
  updateQueueItemSession: (queueId: string, session: QueueRowSession) => void;
  /** Set group name for a queue item */
  setItemGroup: (queueId: string, groupName: string | undefined) => void;
  /** Get all unique group names in the queue */
  getGroupNames: () => string[];
  /** Start group repeat (transmits all items in group as a sequence) */
  startGroupRepeat: (groupName: string) => Promise<void>;
  /** Stop group repeat */
  stopGroupRepeat: (groupName: string) => Promise<void>;
  /** Stop all group repeats */
  stopAllGroupRepeats: () => Promise<void>;
  /** Check if a group is currently repeating */
  isGroupRepeating: (groupName: string) => boolean;

  // Replay Actions
  /** Active replay IDs */
  activeReplays: Set<string>;
  /** Progress info per active replay */
  replayProgress: Map<string, ReplayProgressInfo>;
  /** Replay lifecycle log (started/completed/stopped/error entries) */
  replayLog: ReplayLogEntry[];
  /** Cached replay params keyed by replayId — used to support restart */
  replayCache: Map<string, { sessionId: string; frames: ReplayFrame[]; speed: number; loop: boolean }>;
  /** Start a time-accurate frame replay */
  startReplay: (sessionId: string, replayId: string, frames: ReplayFrame[], speed: number, loop: boolean) => Promise<void>;
  /** Stop a specific replay */
  stopReplay: (replayId: string) => Promise<void>;
  /** Restart a replay from the beginning using its cached params */
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

type QueueRowSession = Pick<Session, "id" | "profileId" | "profileName">;

const mintId = (prefix: string) => `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;

function patchRows(
  queue: TransmitQueueItem[],
  matches: (q: TransmitQueueItem) => boolean,
  patch: Partial<TransmitQueueItem> | ((q: TransmitQueueItem) => Partial<TransmitQueueItem>)
): TransmitQueueItem[] {
  return queue.map((q) => (matches(q) ? { ...q, ...(typeof patch === "function" ? patch(q) : patch) } : q));
}

const byId = (queueId: string) => (q: TransmitQueueItem) => q.id === queueId;
const inGroup = (groupName: string) => (q: TransmitQueueItem) => q.groupName === groupName;

function groupStopped(state: TransmitState, groupName: string): Partial<TransmitState> {
  const activeGroups = new Set(state.activeGroups);
  activeGroups.delete(groupName);
  return { activeGroups, queue: patchRows(state.queue, inGroup(groupName), { isRepeating: false }) };
}

const TERMINAL_LOG_KIND = { finished: "completed", stopped: "stoppedByUser", failed: "deviceError" } as const;

function syncQueuedMarks(queue: TransmitQueueItem[], sessionIds: Iterable<string>) {
  const { setHasQueuedMessages } = useSessionStore.getState();
  for (const id of new Set(sessionIds)) {
    setHasQueuedMessages(id, queue.some((q) => q.sessionId === id));
  }
}

export const useTransmitStore = create<TransmitState>((set, get) => ({
  // ---- Initial State ----
  profiles: [],
  queue: [],
  historyDbCount: 0,
  activeGroups: new Set(),
  activeReplays: new Set(),
  replayProgress: new Map(),
  replayLog: [],
  replayCache: new Map(),
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

  cleanup: async () => {
    // Stop all repeats if there's an active session
    const session = getActiveSession();
    if (session) {
      await ioStopAllRepeats(session.id).catch(() => {});
      await ioStopAllGroupRepeats().catch(() => {});
    }

    const state = get();
    set({
      queue: patchRows(state.queue, () => true, { isRepeating: false }),
      activeGroups: new Set(),
    });
  },

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

  parseSerialBytes: () => {
    const state = get();
    const hex = state.serialEditor.hexInput.replace(/\s/g, "");
    const bytes: number[] = [];

    for (let i = 0; i < hex.length; i += 2) {
      const byte = parseInt(hex.slice(i, i + 2), 16);
      if (!isNaN(byte)) {
        bytes.push(byte);
      }
    }

    return bytes;
  },

  // Queue Actions
  addCanToQueue: () => {
    const state = get();
    const session = getActiveSession();

    if (!session) {
      set({ error: "No IO session connected. Use 'Data Source' to connect." });
      return;
    }

    const frame = get().buildCanFrame();
    if (!frame) return;

    const item: TransmitQueueItem = {
      id: mintId("queue"),
      profileId: session.profileId,
      profileName: session.profileName,
      type: "can",
      canFrame: frame,
      repeatIntervalMs: state.queueRepeatIntervalMs,
      isRepeating: false,
      enabled: true,
      sessionId: session.id,
    };

    set({ queue: [...state.queue, item] });
    useSessionStore.getState().setHasQueuedMessages(session.id, true);
  },

  addCanFramesBulk: (frames, session, intervalMs, groupName) => {
    const state = get();
    const newItems: TransmitQueueItem[] = frames.map((f) => ({
      id: mintId("queue"),
      profileId: session.profileId,
      profileName: session.profileName,
      sessionId: session.id,
      type: "can" as const,
      canFrame: toTransmitFrame({ ...f, bytes: f.bytes.slice(0, f.dlc) }),
      repeatIntervalMs: intervalMs ?? state.queueRepeatIntervalMs,
      isRepeating: false,
      enabled: true,
      groupName: groupName || undefined,
    }));
    set({ queue: [...state.queue, ...newItems] });
    useSessionStore.getState().setHasQueuedMessages(session.id, true);
  },

  addSerialToQueue: () => {
    const state = get();
    const session = getActiveSession();
    const { serialEditor, queueRepeatIntervalMs } = state;

    if (!session) {
      set({ error: "No IO session connected. Use 'Data Source' to connect." });
      return;
    }

    const rawBytes = get().parseSerialBytes();
    if (rawBytes.length === 0) return;

    const item: TransmitQueueItem = {
      id: mintId("queue"),
      profileId: session.profileId,
      profileName: session.profileName,
      type: "serial",
      serialBytes: rawBytes,
      serialFraming: serialFraming(serialEditor.framingMode, serialEditor.delimiter),
      repeatIntervalMs: queueRepeatIntervalMs,
      isRepeating: false,
      enabled: true,
      sessionId: session.id,
    };

    set({ queue: [...state.queue, item] });
    useSessionStore.getState().setHasQueuedMessages(session.id, true);
  },

  removeFromQueue: (queueId) => {
    const state = get();
    const item = state.queue.find((q) => q.id === queueId);

    // Stop repeat if running
    if (item?.isRepeating) {
      ioStopRepeatTransmit(queueId).catch(() => {});
    }

    set({ queue: state.queue.filter((q) => q.id !== queueId) });
    if (item) syncQueuedMarks(get().queue, [item.sessionId]);
  },

  clearQueue: async () => {
    const state = get();
    const sessionIds = state.queue.map((q) => q.sessionId);

    // Stop all repeats
    for (const item of state.queue) {
      if (item.isRepeating) {
        await ioStopRepeatTransmit(item.id).catch(() => {});
      }
    }

    set({ queue: [] });
    syncQueuedMarks([], sessionIds);
  },

  startRepeat: async (queueId) => {
    const state = get();
    const item = state.queue.find((q) => q.id === queueId);
    if (!item || item.isRepeating) return;

    const session = useSessionStore.getState().sessions[item.sessionId];

    if (!session || session.lifecycleState !== "connected") {
      set({ error: `Session '${item.profileName}' is not connected. Connect to it first.` });
      return;
    }

    // Check capabilities based on item type
    if (item.type === "can") {
      if (!session.capabilities?.traits.tx_frames) {
        set({ error: `Session '${item.profileName}' does not support CAN transmit` });
        return;
      }
      if (!item.canFrame) {
        set({ error: "CAN frame is missing" });
        return;
      }
    } else if (item.type === "serial") {
      if (!session.capabilities?.traits.tx_bytes) {
        set({ error: `Session '${item.profileName}' does not support serial transmit` });
        return;
      }
      if (!item.serialBytes || item.serialBytes.length === 0) {
        set({ error: "Serial bytes are missing" });
        return;
      }
    }

    try {
      if (item.type === "can" && item.canFrame) {
        await ioStartRepeatTransmit(
          session.id,
          queueId,
          item.canFrame,
          item.repeatIntervalMs
        );
      } else if (item.type === "serial" && item.serialBytes) {
        await ioStartSerialRepeatTransmit(
          session.id,
          queueId,
          item.serialBytes,
          item.serialFraming ?? { mode: "raw" },
          item.repeatIntervalMs
        );
      }

      set({ queue: patchRows(state.queue, byId(queueId), { isRepeating: true }) });
    } catch (e) {
      set({ error: String(e) });
    }
  },

  stopRepeat: async (queueId) => {
    const state = get();
    const item = state.queue.find((q) => q.id === queueId);
    if (!item || !item.isRepeating) return;

    try {
      await ioStopRepeatTransmit(queueId);

      set({ queue: patchRows(state.queue, byId(queueId), { isRepeating: false }) });
    } catch (e) {
      set({ error: String(e) });
    }
  },

  // Called by backend event when repeat stops due to permanent error
  // No API call needed since backend already stopped
  markRepeatStopped: (queueId) => {
    const state = get();
    set(
      state.activeGroups.has(queueId)
        ? groupStopped(state, queueId)
        : { queue: patchRows(state.queue, byId(queueId), { isRepeating: false }) }
    );
  },

  markGroupRepeating: (groupName) => {
    const state = get();
    set({
      activeGroups: new Set([...state.activeGroups, groupName]),
      queue: patchRows(state.queue, (q) => q.groupName === groupName && q.enabled && q.type === "can", { isRepeating: true }),
    });
  },

  // Every repeat start is announced by the backend, the UI's own included. A row
  // the queue already holds keeps its fields (group, notes) and is marked
  // repeating; an agent's arrives here for the first time and is added.
  addExternalRepeat: (ev) => {
    const { queue_id, session_id, profile_id, profile_name, interval_ms, origin, ...canFrame } = ev;
    const state = get();
    const exists = state.queue.some((q) => q.id === queue_id);
    const item: TransmitQueueItem = {
      id: queue_id,
      profileId: profile_id,
      profileName: profile_name,
      type: "can",
      canFrame,
      repeatIntervalMs: interval_ms,
      isRepeating: true,
      enabled: true,
      origin: origin === "agent" ? "agent" : "user",
      sessionId: session_id,
    };
    set({
      queue: exists
        ? patchRows(state.queue, byId(queue_id), { isRepeating: true, repeatIntervalMs: interval_ms, sessionId: session_id })
        : [...state.queue, item],
    });
    useSessionStore.getState().setHasQueuedMessages(session_id, true);
  },

  stopAllRepeats: async () => {
    const state = get();
    const session = getActiveSession();

    if (session) {
      try {
        await ioStopAllRepeats(session.id);
      } catch {
        // Continue to update UI state even if backend call fails
      }
    }

    set({ queue: patchRows(state.queue, () => true, { isRepeating: false }) });
  },

  updateQueueInterval: (queueId, intervalMs) => {
    set({ queue: patchRows(get().queue, byId(queueId), { repeatIntervalMs: intervalMs }) });
  },

  toggleQueueEnabled: (queueId) => {
    const state = get();
    const item = state.queue.find((q) => q.id === queueId);
    if (!item) return;

    // If disabling while repeating, stop the repeat
    if (item.enabled && item.isRepeating) {
      ioStopRepeatTransmit(queueId).catch(() => {});
    }

    set({ queue: patchRows(state.queue, byId(queueId), { enabled: !item.enabled, isRepeating: false }) });
  },

  updateQueueItemBus: (queueId, bus) => {
    set({
      queue: patchRows(get().queue, (q) => q.id === queueId && q.type === "can" && !!q.canFrame, (q) => ({
        canFrame: { ...q.canFrame!, bus },
      })),
    });
  },

  updateQueueItemSession: (queueId, session) => {
    const state = get();
    const item = state.queue.find((q) => q.id === queueId);
    if (!item) return;

    set({
      queue: patchRows(state.queue, byId(queueId), {
        sessionId: session.id,
        profileId: session.profileId,
        profileName: session.profileName,
      }),
    });
    syncQueuedMarks(get().queue, [item.sessionId, session.id]);
  },

  // Group Actions
  setItemGroup: (queueId, groupName) => {
    set({ queue: patchRows(get().queue, byId(queueId), { groupName: groupName || undefined }) });
  },

  getGroupNames: () => {
    const state = get();
    const groups = new Set<string>();
    for (const item of state.queue) {
      if (item.groupName) {
        groups.add(item.groupName);
      }
    }
    return Array.from(groups).sort();
  },

  isGroupRepeating: (groupName) => {
    return get().activeGroups.has(groupName);
  },

  startGroupRepeat: async (groupName) => {
    const state = get();

    // Already repeating?
    if (state.activeGroups.has(groupName)) {
      return;
    }

    // Get all enabled CAN items in this group, in queue order
    const groupItems = state.queue.filter(
      (q) => q.groupName === groupName && q.enabled && q.type === "can" && q.canFrame
    );

    if (groupItems.length === 0) {
      set({ error: `No enabled CAN frames in group '${groupName}'` });
      return;
    }

    const { sessions } = useSessionStore.getState();
    const members: RepeatGroupMember[] = [];
    for (const item of groupItems) {
      const session = sessions[item.sessionId];
      if (!session || session.lifecycleState !== "connected") {
        set({ error: `Session '${item.profileName}' is not connected. Connect to it first.` });
        return;
      }
      if (!session.capabilities?.traits.tx_frames) {
        set({ error: `Session '${item.profileName}' does not support transmit` });
        return;
      }
      const last = members[members.length - 1];
      if (last?.session_id === session.id) last.frames.push(item.canFrame!);
      else members.push({ session_id: session.id, frames: [item.canFrame!] });
    }

    try {
      await ioStartRepeatGroup(groupName, members, groupItems[0].repeatIntervalMs);
    } catch (e) {
      set({ error: String(e) });
    }
  },

  stopGroupRepeat: async (groupName) => {
    const state = get();

    if (!state.activeGroups.has(groupName)) {
      return;
    }

    try {
      await ioStopRepeatGroup(groupName);
      set(groupStopped(state, groupName));
    } catch (e) {
      set({ error: String(e) });
    }
  },

  stopAllGroupRepeats: async () => {
    const state = get();

    if (state.activeGroups.size === 0) {
      return;
    }

    try {
      await ioStopAllGroupRepeats();

      set({ activeGroups: new Set(), queue: patchRows(state.queue, (q) => !!q.groupName, { isRepeating: false }) });
    } catch (e) {
      set({ error: String(e) });
    }
  },

  // Replay Actions
  startReplay: async (sessionId, replayId, frames, speed, loop) => {
    try {
      await ioStartReplay(sessionId, replayId, frames, speed, loop);
      set((state) => ({ replayCache: new Map(state.replayCache).set(replayId, { sessionId, frames, speed, loop }) }));
    } catch (e) {
      set({ error: String(e) });
    }
  },

  stopReplay: async (replayId) => {
    await ioStopReplay(replayId).catch((e) => set({ error: String(e) }));
  },

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

  restartReplay: async (replayId) => {
    const cached = get().replayCache.get(replayId);
    if (!cached) return;
    const { sessionId, frames, speed, loop } = cached;
    await ioStartReplay(sessionId, replayId, frames, speed, loop).catch((e) => set({ error: String(e) }));
  },

  clearReplayLog: (sessionId) =>
    set((state) => ({ replayLog: state.replayLog.filter((e) => e.sessionId !== sessionId) })),

  // Error handling
  clearError: () => set({ error: null }),
}));
