// ui/src/stores/updateStore.ts
// Store for update checking state

import { create } from "zustand";
import { checkForUpdates, tlog, type UpdateInfo } from "../api/settings";

interface UpdateState {
  availableUpdate: UpdateInfo | null;
  checkForUpdates: () => Promise<void>;
}

export const useUpdateStore = create<UpdateState>((set) => ({
  availableUpdate: null,

  checkForUpdates: async () => {
    try {
      const update = await checkForUpdates();
      set({ availableUpdate: update });
    } catch (error) {
      // Silently fail - don't bother user if offline or API unavailable
      tlog.info(`[updateStore] Failed to check for updates: ${error}`);
    }
  },
}));
