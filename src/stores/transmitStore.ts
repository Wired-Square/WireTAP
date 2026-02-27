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
  getTransmitCapableProfiles,
  // IO session-based transmit
  ioTransmitCanFrame,
  ioStartRepeatTransmit,
  ioStartSerialRepeatTransmit,
  ioStopRepeatTransmit,
  ioStopAllRepeats,
  // IO session group repeat
  ioStartRepeatGroup,
  ioStopRepeatGroup,
  ioStopAllGroupRepeats,
} from "../api/transmit";

import { useSessionStore } from "./sessionStore";

import { CAN_FD_DLC_VALUES } from "../constants";

// ============================================================================
// Types
// ============================================================================

/** Active tab in the transmit UI */
export type TransmitTab = "frame" | "queue" | "history";

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
  /** Serial bytes (if type is 'serial') */
  serialBytes?: number[];
  /** Framing mode for serial (if type is 'serial') */
  framingMode?: string;
  /** Repeat interval in milliseconds (0 = single shot) */
  repeatIntervalMs: number;
  /** Whether this item is currently repeating */
  isRepeating: boolean;
  /** Whether this item is enabled */
  enabled: boolean;
  /** Group name for grouped repeat (items with same group are sent together in sequence) */
  groupName?: string;
}

/** History entry for transmitted packets */
export interface TransmitHistoryItem {
  /** Unique ID */
  id: string;
  /** Timestamp in microseconds since UNIX epoch */
  timestamp_us: number;
  /** Profile ID used for transmission */
  profileId: string;
  /** Display name for the profile */
  profileName: string;
  /** Type of transmission */
  type: "can" | "serial";
  /** CAN frame (if type is 'can') */
  frame?: CanTransmitFrame;
  /** Serial bytes (if type is 'serial') */
  bytes?: number[];
  /** Whether transmission was successful */
  success: boolean;
  /** Error message if failed */
  error?: string;
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
  framingMode: "raw" | "slip" | "delimiter";
  /** Delimiter bytes (for delimiter framing) */
  delimiter: number[];
}

import { useSettingsStore } from '../apps/settings/stores/settingsStore';

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
  /** Transmission history */
  history: TransmitHistoryItem[];
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
  /** Mark repeat as stopped (called by backend event, no API call needed) */
  markRepeatStopped: (queueId: string) => void;
  /** Stop all repeats */
  stopAllRepeats: () => Promise<void>;
  /** Update queue item repeat interval */
  updateQueueInterval: (queueId: string, intervalMs: number) => void;
  /** Toggle queue item enabled state */
  toggleQueueEnabled: (queueId: string) => void;
  /** Update queue item bus (CAN only) */
  updateQueueItemBus: (queueId: string, bus: number) => void;
  /** Reassign queue item to a different session */
  updateQueueItemSession: (
    queueId: string,
    profileId: string,
    profileName: string
  ) => void;
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

  // History Actions
  /** Clear history */
  clearHistory: () => void;
  /** Add item to history (internal) */
  addHistoryItem: (item: Omit<TransmitHistoryItem, "id">) => void;

  // Error handling
  /** Clear error */
  clearError: () => void;
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

export const useTransmitStore = create<TransmitState>((set, get) => ({
  // ---- Initial State ----
  profiles: [],
  queue: [],
  history: [],
  activeGroups: new Set(),
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

    // Update queue items to stopped state
    const state = get();
    set({
      queue: state.queue.map((item) => ({ ...item, isRepeating: false })),
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

    // BRS requires FD
    if (updates.isFd === false) {
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

    if (!session.capabilities?.can_transmit) {
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

      // Add to history
      get().addHistoryItem({
        timestamp_us: result.timestamp_us,
        profileId: session.profileId,
        profileName: session.profileName ?? "IO Session",
        type: "can",
        frame,
        success: result.success,
        error: result.error,
      });

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
      id: `queue-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      profileId: session.profileId,
      profileName: session.profileName,
      type: "can",
      canFrame: frame,
      repeatIntervalMs: state.queueRepeatIntervalMs,
      isRepeating: false,
      enabled: true,
    };

    set({ queue: [...state.queue, item] });
    useSessionStore.getState().setHasQueuedMessages(session.profileId, true);
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

    // Apply framing to bytes (same as single-shot in SerialTransmitView)
    let bytesToStore = [...rawBytes];
    if (serialEditor.framingMode === "slip") {
      // SLIP framing: END(0xC0), escape special chars, END(0xC0)
      const SLIP_END = 0xc0;
      const SLIP_ESC = 0xdb;
      const SLIP_ESC_END = 0xdc;
      const SLIP_ESC_ESC = 0xdd;
      const framed: number[] = [SLIP_END];
      for (const b of rawBytes) {
        if (b === SLIP_END) {
          framed.push(SLIP_ESC, SLIP_ESC_END);
        } else if (b === SLIP_ESC) {
          framed.push(SLIP_ESC, SLIP_ESC_ESC);
        } else {
          framed.push(b);
        }
      }
      framed.push(SLIP_END);
      bytesToStore = framed;
    } else if (serialEditor.framingMode === "delimiter") {
      // Append delimiter
      bytesToStore = [...rawBytes, ...serialEditor.delimiter];
    }

    const item: TransmitQueueItem = {
      id: `queue-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      profileId: session.profileId,
      profileName: session.profileName,
      type: "serial",
      serialBytes: bytesToStore,
      framingMode:
        serialEditor.framingMode === "raw" ? undefined : serialEditor.framingMode,
      repeatIntervalMs: queueRepeatIntervalMs,
      isRepeating: false,
      enabled: true,
    };

    set({ queue: [...state.queue, item] });
    useSessionStore.getState().setHasQueuedMessages(session.profileId, true);
  },

  removeFromQueue: (queueId) => {
    const state = get();
    const item = state.queue.find((q) => q.id === queueId);

    // Stop repeat if running
    if (item?.isRepeating) {
      ioStopRepeatTransmit(queueId).catch(() => {});
    }

    set({ queue: state.queue.filter((q) => q.id !== queueId) });

    // Update hasQueuedMessages flag if no items remain for this profile
    if (item) {
      const remainingForProfile = get().queue.filter(
        (q) => q.profileId === item.profileId
      );
      if (remainingForProfile.length === 0) {
        useSessionStore.getState().setHasQueuedMessages(item.profileId, false);
      }
    }
  },

  clearQueue: async () => {
    const state = get();

    // Collect unique profile IDs before clearing
    const profileIds = new Set(state.queue.map((q) => q.profileId));

    // Stop all repeats
    for (const item of state.queue) {
      if (item.isRepeating) {
        await ioStopRepeatTransmit(item.id).catch(() => {});
      }
    }

    set({ queue: [] });

    // Clear hasQueuedMessages flag for all affected profiles
    const { setHasQueuedMessages } = useSessionStore.getState();
    for (const profileId of profileIds) {
      setHasQueuedMessages(profileId, false);
    }
  },

  startRepeat: async (queueId) => {
    const state = get();
    const item = state.queue.find((q) => q.id === queueId);
    if (!item || item.isRepeating) return;

    // Use the session that was stored with the queue item, not the currently active one
    const { sessions } = useSessionStore.getState();
    const session = sessions[item.profileId];

    if (!session || session.lifecycleState !== "connected") {
      set({ error: `Session '${item.profileName}' is not connected. Connect to it first.` });
      return;
    }

    // Check capabilities based on item type
    if (item.type === "can") {
      if (!session.capabilities?.can_transmit) {
        set({ error: `Session '${item.profileName}' does not support CAN transmit` });
        return;
      }
      if (!item.canFrame) {
        set({ error: "CAN frame is missing" });
        return;
      }
    } else if (item.type === "serial") {
      if (!session.capabilities?.can_transmit_serial) {
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
          item.repeatIntervalMs
        );
      }

      // Update queue item
      set({
        queue: state.queue.map((q) =>
          q.id === queueId ? { ...q, isRepeating: true } : q
        ),
      });
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

      // Update queue item
      set({
        queue: state.queue.map((q) =>
          q.id === queueId ? { ...q, isRepeating: false } : q
        ),
      });
    } catch (e) {
      set({ error: String(e) });
    }
  },

  // Called by backend event when repeat stops due to permanent error
  // No API call needed since backend already stopped
  markRepeatStopped: (queueId) => {
    const state = get();
    // Check if it's a group - if so, remove from activeGroups too
    const item = state.queue.find((q) => q.id === queueId);
    if (item?.groupName) {
      const newActiveGroups = new Set(state.activeGroups);
      newActiveGroups.delete(item.groupName);
      set({
        activeGroups: newActiveGroups,
        queue: state.queue.map((q) =>
          q.groupName === item.groupName ? { ...q, isRepeating: false } : q
        ),
      });
    } else {
      set({
        queue: state.queue.map((q) =>
          q.id === queueId ? { ...q, isRepeating: false } : q
        ),
      });
    }
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

    // Update all items to not repeating
    set({
      queue: state.queue.map((q) => ({ ...q, isRepeating: false })),
    });
  },

  updateQueueInterval: (queueId, intervalMs) => {
    const state = get();
    set({
      queue: state.queue.map((q) =>
        q.id === queueId ? { ...q, repeatIntervalMs: intervalMs } : q
      ),
    });
  },

  toggleQueueEnabled: (queueId) => {
    const state = get();
    const item = state.queue.find((q) => q.id === queueId);
    if (!item) return;

    // If disabling while repeating, stop the repeat
    if (item.enabled && item.isRepeating) {
      ioStopRepeatTransmit(queueId).catch(() => {});
    }

    set({
      queue: state.queue.map((q) =>
        q.id === queueId
          ? { ...q, enabled: !q.enabled, isRepeating: false }
          : q
      ),
    });
  },

  updateQueueItemBus: (queueId, bus) => {
    const state = get();
    set({
      queue: state.queue.map((q) =>
        q.id === queueId && q.type === "can" && q.canFrame
          ? { ...q, canFrame: { ...q.canFrame, bus } }
          : q
      ),
    });
  },

  updateQueueItemSession: (queueId, profileId, profileName) => {
    const state = get();
    const item = state.queue.find((q) => q.id === queueId);
    const oldProfileId = item?.profileId;

    set({
      queue: state.queue.map((q) =>
        q.id === queueId ? { ...q, profileId, profileName } : q
      ),
    });

    // Update hasQueuedMessages flags
    const { setHasQueuedMessages } = useSessionStore.getState();
    setHasQueuedMessages(profileId, true);

    // Check if old profile still has items
    if (oldProfileId && oldProfileId !== profileId) {
      const remainingForOld = state.queue.filter(
        (q) => q.id !== queueId && q.profileId === oldProfileId
      );
      if (remainingForOld.length === 0) {
        setHasQueuedMessages(oldProfileId, false);
      }
    }
  },

  // Group Actions
  setItemGroup: (queueId, groupName) => {
    const state = get();
    set({
      queue: state.queue.map((q) =>
        q.id === queueId ? { ...q, groupName: groupName || undefined } : q
      ),
    });
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

    // Group items by session (profileId)
    const itemsBySession = new Map<string, typeof groupItems>();
    for (const item of groupItems) {
      const existing = itemsBySession.get(item.profileId) || [];
      existing.push(item);
      itemsBySession.set(item.profileId, existing);
    }

    // Validate all sessions are connected and can transmit
    const { sessions } = useSessionStore.getState();
    for (const [profileId, items] of itemsBySession) {
      const session = sessions[profileId];
      if (!session || session.lifecycleState !== "connected") {
        set({ error: `Session '${items[0].profileName}' is not connected. Connect to it first.` });
        return;
      }
      if (!session.capabilities?.can_transmit) {
        set({ error: `Session '${items[0].profileName}' does not support transmit` });
        return;
      }
    }

    // Use interval from first item in group (applies to all sub-groups)
    const intervalMs = groupItems[0].repeatIntervalMs;

    try {
      // Start a repeat for each session's frames
      // Use unique sub-group names to track them: "groupName:profileId"
      for (const [profileId, items] of itemsBySession) {
        const session = sessions[profileId];
        const frames = items.map((q) => q.canFrame!);
        const subGroupName = itemsBySession.size > 1 ? `${groupName}:${profileId}` : groupName;
        await ioStartRepeatGroup(session.id, subGroupName, frames, intervalMs);
      }

      // Mark group as active and items as repeating
      const newActiveGroups = new Set(state.activeGroups);
      newActiveGroups.add(groupName);

      set({
        activeGroups: newActiveGroups,
        queue: state.queue.map((q) =>
          q.groupName === groupName && q.enabled && q.type === "can"
            ? { ...q, isRepeating: true }
            : q
        ),
      });
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
      // Get unique profile IDs for items in this group (to stop sub-groups)
      const groupItems = state.queue.filter(
        (q) => q.groupName === groupName && q.type === "can"
      );
      const profileIds = [...new Set(groupItems.map((q) => q.profileId))];

      // Stop the main group and any sub-groups (groupName:profileId)
      await ioStopRepeatGroup(groupName);
      if (profileIds.length > 1) {
        // Multi-session group - stop each sub-group
        for (const profileId of profileIds) {
          await ioStopRepeatGroup(`${groupName}:${profileId}`).catch(() => {});
        }
      }

      // Remove group from active and mark items as not repeating
      const newActiveGroups = new Set(state.activeGroups);
      newActiveGroups.delete(groupName);

      set({
        activeGroups: newActiveGroups,
        queue: state.queue.map((q) =>
          q.groupName === groupName ? { ...q, isRepeating: false } : q
        ),
      });
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

      // Clear all active groups and mark all grouped items as not repeating
      set({
        activeGroups: new Set(),
        queue: state.queue.map((q) =>
          q.groupName ? { ...q, isRepeating: false } : q
        ),
      });
    } catch (e) {
      set({ error: String(e) });
    }
  },

  // History Actions
  clearHistory: () => set({ history: [] }),

  addHistoryItem: (item) => {
    const state = get();
    const id = `history-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const newItem: TransmitHistoryItem = { ...item, id };

    // Prepend to history, cap at max
    const maxHistory = useSettingsStore.getState().buffers.transmitMaxHistory;
    const history = [newItem, ...state.history].slice(0, maxHistory);
    set({ history });
  },

  // Error handling
  clearError: () => set({ error: null }),
}));
