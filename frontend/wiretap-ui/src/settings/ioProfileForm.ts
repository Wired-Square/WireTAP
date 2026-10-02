// src/settings/ioProfileForm.ts
//
// Shared IO profile form logic, used by the Settings profile dialog and by the
// source picker's device editor so an ad-hoc device is settled the same way as
// a saved one.

import { storeCredential, SECURE_FIELDS } from "../api/credentials";
import { defaultConnectionForKind } from "../api/deviceKinds";
import type { IOProfile, ConnectionTypeMap } from "./appSettings";

/**
 * Fill each field the kind defaults and the form left blank with Rust's value,
 * spelled as the form writes it.
 */
export async function applyConnectionDefaults(profile: IOProfile): Promise<IOProfile> {
  const defaults = await defaultConnectionForKind(profile.kind);
  const connection: Record<string, unknown> = { ...profile.connection };
  for (const [key, value] of Object.entries(defaults)) {
    const current = connection[key];
    if (current === undefined || current === null || current === "") {
      connection[key] = typeof value === "number" ? String(value) : value;
    }
  }
  return { ...profile, connection } as IOProfile;
}

/**
 * Prepare a profile for settings.json: move its secrets into the OS keyring
 * behind a `_<field>_stored` marker, and drop the run-lifetime `ephemeral`
 * flag. Every persist path goes through here — a password left in `connection`
 * would be written out in plaintext, and an `ephemeral` profile that reached
 * disk would come back as a saved one.
 *
 * Ad-hoc devices deliberately skip it: they never reach disk, and the Rust
 * `resolve_secret` falls back to the inline value when there is no marker.
 */
export async function storeProfileSecrets(
  profile: IOProfile,
  profileId: string,
): Promise<IOProfile> {
  const { ephemeral: _ephemeral, ...rest } = profile;
  const connection = { ...rest.connection } as Record<string, unknown>;
  for (const field of SECURE_FIELDS) {
    const value = connection[field];
    if (value && typeof value === "string" && value.trim()) {
      await storeCredential(profileId, field, value);
      connection[`_${field}_stored`] = true;
    }
    delete connection[field];
  }
  return {
    ...rest,
    id: profileId,
    connection: connection as ConnectionTypeMap[typeof profile.kind],
  } as IOProfile;
}

/**
 * Mint an id for a saved profile. Kept disjoint from `newAdHocProfileId`'s
 * `adhoc_` namespace, which the backend overlay relies on.
 */
export function newSavedProfileId(): string {
  return `io_${Date.now()}`;
}
