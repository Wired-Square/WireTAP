// Simple store to track panel focus and open panels per window
// This avoids race conditions with event-based focus tracking

import { create } from "zustand";

interface FocusState {
  /** The currently focused panel ID, or null if none */
  focusedPanelId: string | null;
  /** IDs of all currently open Dockview panels */
  openPanelIds: string[];
  /** Map of panelId → listenerId for session-aware apps (e.g., "query" → "query_k3f7") */
  listenerIds: Record<string, string>;
  /** Set the focused panel ID */
  setFocusedPanelId: (panelId: string | null) => void;
  /** Track a panel being opened */
  addOpenPanel: (panelId: string) => void;
  /** Track a panel being closed */
  removeOpenPanel: (panelId: string) => void;
  /** Seed the full set of open panels (e.g., after layout restore) */
  setOpenPanels: (panelIds: string[]) => void;
  /** Register a listener ID for an app panel */
  setListenerId: (panelId: string, listenerId: string) => void;
  /** Remove a listener ID when an app panel unmounts */
  removeListenerId: (panelId: string) => void;
}

export const useFocusStore = create<FocusState>((set) => ({
  focusedPanelId: null,
  openPanelIds: [],
  listenerIds: {},
  setFocusedPanelId: (panelId) => set({ focusedPanelId: panelId }),
  addOpenPanel: (panelId) =>
    set((s) =>
      s.openPanelIds.includes(panelId)
        ? s
        : { openPanelIds: [...s.openPanelIds, panelId] }
    ),
  removeOpenPanel: (panelId) =>
    set((s) => {
      const { [panelId]: _, ...remainingListenerIds } = s.listenerIds;
      return {
        openPanelIds: s.openPanelIds.filter((id) => id !== panelId),
        listenerIds: remainingListenerIds,
      };
    }),
  setOpenPanels: (panelIds) => set({ openPanelIds: panelIds }),
  setListenerId: (panelId, listenerId) =>
    set((s) => ({ listenerIds: { ...s.listenerIds, [panelId]: listenerId } })),
  removeListenerId: (panelId) =>
    set((s) => {
      const { [panelId]: _, ...rest } = s.listenerIds;
      return { listenerIds: rest };
    }),
}));
