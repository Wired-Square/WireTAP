// Simple store to track the focused panel per window
// This avoids race conditions with event-based focus tracking

import { create } from "zustand";

interface FocusState {
  /** The currently focused panel ID, or null if none */
  focusedPanelId: string | null;
  /** Set the focused panel ID */
  setFocusedPanelId: (panelId: string | null) => void;
}

export const useFocusStore = create<FocusState>((set) => ({
  focusedPanelId: null,
  setFocusedPanelId: (panelId) => set({ focusedPanelId: panelId }),
}));
