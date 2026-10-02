// src/stores/adHocProfileStore.ts
//
// Mirror of the Rust ephemeral profile registry (crates/wiretap-app/src/io/ephemeral.rs).
// Rust is authoritative: every mutation returns the new list and we take it
// wholesale rather than patching locally, so a discard racing another window
// leaves the store in step with the backend.
//
// Ad-hoc devices are deliberately absent from `settings.io_profiles` (see
// normalizeSettings). Anything that needs saved *and* ad-hoc devices — the
// source picker, useIOSessionManager — should use `useAllIOProfiles()`.

import { create } from "zustand";
import { listEphemeralProfiles, unregisterEphemeralProfile } from "../api/ephemeralProfiles";
import type { IOProfile } from "../settings/appSettings";
import { useProfileBusStore } from "./profileBusStore";

interface AdHocProfileState {
  profiles: IOProfile[];
  /** Pull the current list from the backend (on app start, after a reload, and after a create). */
  refresh: () => Promise<void>;
  /** Discard an ad-hoc device. */
  discard: (profileId: string) => Promise<void>;
}

export const useAdHocProfileStore = create<AdHocProfileState>((set) => ({
  profiles: [],

  refresh: async () => {
    set({ profiles: await listEphemeralProfiles() });
  },

  discard: async (profileId) => {
    set({ profiles: await unregisterEphemeralProfile(profileId) });
    useProfileBusStore.getState().invalidate();
  },
}));
