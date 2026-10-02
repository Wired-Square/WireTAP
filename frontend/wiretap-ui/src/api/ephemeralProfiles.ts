// src/api/ephemeralProfiles.ts
//
// API wrapper for creating and changing IO devices, saved or ad-hoc. Ad-hoc
// devices live in the Rust ephemeral registry for this run only, never in
// settings.json; the backend overlays them onto AppSettings.io_profiles, so they
// open sessions, probe and transmit exactly like a saved profile.

import { invoke } from "@tauri-apps/api/core";
import type { IOProfile } from "../settings/appSettings";
import type { ProfileValidationError } from "../generated/ProfileValidationError";

/** A device as the user described it; the backend mints the id. */
export type DeviceDraft = Omit<IOProfile, "id" | "ephemeral">;

/** What a device write rejects with when a rule, rather than the system, refused it. */
export function isProfileValidationError(e: unknown): e is ProfileValidationError {
  return typeof e === "object" && e !== null && "code" in e;
}

/**
 * Create a device: saved to settings.json when `persist`, otherwise ad-hoc for
 * this run. Rejects with a `DeviceWriteError`.
 */
export async function createDevice(draft: DeviceDraft, persist: boolean): Promise<IOProfile> {
  return invoke<IOProfile>("create_device", { draft, persist });
}

/** Replace a device's name, kind and connection. Rejects with a `DeviceWriteError`. */
export async function updateDevice(profile: IOProfile): Promise<IOProfile> {
  return invoke<IOProfile>("update_device", { profile });
}

/** Save an ad-hoc device to settings under a new id; the ad-hoc copy stays. */
export async function saveAdHocDevice(profileId: string, name: string): Promise<IOProfile> {
  return invoke<IOProfile>("save_ad_hoc_device", { profile_id: profileId, name });
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
 * Change a device's connection parameters, and reconnect anything using it.
 *
 * The backend owns the whole operation — defaults, validation, splitting
 * secrets into the keyring, writing the profile wherever it lives, then dropping
 * and re-establishing the live source so it picks the new settings up. The
 * session id is unchanged, so apps watching it stay attached and simply see the
 * device reconnect. Rejects with a `DeviceWriteError`.
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
