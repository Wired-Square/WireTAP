// Cross-window roster of open session-aware app instances.
//
// Unlike focusStore (which tracks only the panels open in THIS window), this store
// holds the Rust-owned registry of every open app instance across ALL windows. It
// is reconciled from listOpenApps() on each OpenAppsChanged broadcast — see
// useOpenAppsSync. The Session Manager graph sources its app nodes from here so it
// can show apps from every window.

import { create } from "zustand";
import type { AppInstanceInfo } from "../api/io";

interface OpenAppsState {
  /** Every open app instance across all windows (Rust-authoritative). */
  instances: AppInstanceInfo[];
  /** Replace the full roster (full-snapshot reconcile). */
  setInstances: (instances: AppInstanceInfo[]) => void;
}

export const useOpenAppsStore = create<OpenAppsState>((set) => ({
  instances: [],
  setInstances: (instances) => set({ instances }),
}));
