// src/stores/adHocProfileStore.ts
//
// Mirror of the Rust ephemeral profile registry (crates/wiretap-app/src/io/ephemeral.rs).
// Rust is authoritative: every mutation returns the new list and we take it
// wholesale rather than patching locally, so a rejected register or a discard
// racing another window leaves the store in step with the backend.
//
// Ad-hoc devices are deliberately absent from `settings.io_profiles` (see
// normalizeSettings). Anything that needs saved *and* ad-hoc devices — the
// source picker, useIOSessionManager — should use `useAllIOProfiles()`.

import { create } from "zustand";
import {
  listEphemeralProfiles,
  registerEphemeralProfile,
  unregisterEphemeralProfile,
} from "../api/ephemeralProfiles";
import type { IOProfile } from "../settings/appSettings";
import { useProfileBusStore } from "./profileBusStore";

/** Mint an id for an ad-hoc device, disjoint from the saved `io_` namespace. */
export function newAdHocProfileId(): string {
  return `adhoc_${Date.now()}`;
}

interface AdHocProfileState {
  profiles: IOProfile[];
  /** Pull the current list from the backend (on app start, and after a reload). */
  refresh: () => Promise<void>;
  /** Add or replace an ad-hoc device. The caller mints the id. */
  register: (profile: IOProfile) => Promise<void>;
  /** Discard an ad-hoc device. */
  discard: (profileId: string) => Promise<void>;
}

export const useAdHocProfileStore = create<AdHocProfileState>((set) => ({
  profiles: [],

  refresh: async () => {
    set({ profiles: await listEphemeralProfiles() });
  },

  register: async (profile) => {
    // Rust stamps `ephemeral` itself, and returns the new list.
    set({ profiles: await registerEphemeralProfile(profile) });
    // load_settings overlays ad-hoc devices onto io_profiles, so the declared
    // bus list Rust hands out has just changed.
    useProfileBusStore.getState().invalidate();
  },

  discard: async (profileId) => {
    set({ profiles: await unregisterEphemeralProfile(profileId) });
    useProfileBusStore.getState().invalidate();
  },
}));
