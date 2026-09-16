// Simple per-window store tracking which Dockview panel is focused.
// Used for session-control targeting (the focused panel is the session a menu
// action acts on). The set of OPEN apps now lives in the Rust-owned open-app
// registry (see openAppsStore / useOpenAppsSync), not here.

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
