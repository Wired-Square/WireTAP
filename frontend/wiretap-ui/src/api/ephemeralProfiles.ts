// src/api/ephemeralProfiles.ts
//
// API wrapper for ad-hoc IO devices — profiles registered in the Rust
// ephemeral registry for this run only, never written to settings.json.
// The backend overlays them onto AppSettings.io_profiles, so once registered
// they open sessions, probe and transmit exactly like a saved profile.

import { invoke } from "@tauri-apps/api/core";
import type { IOProfile } from "../settings/appSettings";

/**
 * Add or replace an ad-hoc device. Rejects an id already used by a saved
 * profile. Returns the full ad-hoc list so the caller updates its mirror
 * from one round trip.
 */
export async function registerEphemeralProfile(profile: IOProfile): Promise<IOProfile[]> {
  return invoke<IOProfile[]>("register_ephemeral_profile", { profile });
}

/** Discard an ad-hoc device. Returns the remaining list. */
export async function unregisterEphemeralProfile(profileId: string): Promise<IOProfile[]> {
  return invoke<IOProfile[]>("unregister_ephemeral_profile", { profile_id: profileId });
}

/** Every ad-hoc device registered this run. */
export async function listEphemeralProfiles(): Promise<IOProfile[]> {
  return invoke<IOProfile[]>("list_ephemeral_profiles");
}

/**
 * Drop a profile's cached probe result after its connection parameters changed.
 * Editing a saved device keeps its id, so without this the next probe reports
 * the device it used to point at.
 */
export async function clearProfileProbeCache(profileId: string): Promise<void> {
  return invoke<void>("clear_profile_probe_cache", { profile_id: profileId });
}

/**
 * Change a device's connection parameters, and reconnect anything using it.
 *
 * The backend owns the whole operation — splitting secrets into the keyring,
 * writing the profile wherever it lives, then dropping and re-establishing the
 * live source so it picks the new settings up. The session id is unchanged, so
 * apps watching it stay attached and simply see the device reconnect.
 *
 * @param sessionId  The live session to reconnect, if there is one.
 */
export async function reconfigureDevice(
  profileId: string,
  connection: Record<string, unknown>,
  sessionId?: string | null,
): Promise<void> {
  return invoke<void>("reconfigure_device", {
    profile_id: profileId,
    connection,
    session_id: sessionId ?? null,
  });
}
