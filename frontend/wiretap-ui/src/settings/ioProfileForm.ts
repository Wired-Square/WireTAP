// src/settings/ioProfileForm.ts
//
// Shared IO profile form logic: per-kind connection defaults and validation.
// Used by the Settings profile dialog and by the source picker's device editor,
// so an ad-hoc device gets the same defaults and the same rejections as a saved
// one.

import { storeCredential, SECURE_FIELDS } from "../api/credentials";
import type {
  IOProfile,
  ConnectionTypeMap,
  MqttConnection,
  WiretapConnection,
  GvretTcpConnection,
  SlcanConnection,
  SocketcanConnection,
  ModbusTcpConnection,
  SerialConnection,
  FrameLinkConnection,
} from "./appSettings";

/**
 * Fill in the defaults a profile kind needs to connect at all. Mirrored by the
 * `.unwrap_or(...)` values the Rust readers apply, so a profile saved here and
 * one hand-edited into settings.json behave the same.
 */
export function applyConnectionDefaults(profile: IOProfile): IOProfile {
  switch (profile.kind) {
    case "mqtt": {
      const conn: MqttConnection = { ...profile.connection };
      if (!conn.host) conn.host = "localhost";
      if (!conn.port) conn.port = "1883";
      return { ...profile, connection: conn };
    }
    case "wiretap": {
      const conn: WiretapConnection = { ...profile.connection };
      if (!conn.url) conn.url = "http://localhost:8423";
      if (!conn.database) conn.database = "wiretap";
      return { ...profile, connection: conn };
    }
    case "gvret_tcp": {
      const conn: GvretTcpConnection = { ...profile.connection };
      if (!conn.host) conn.host = "192.168.1.100";
      if (!conn.port) conn.port = "23";
      return { ...profile, connection: conn };
    }
    case "framelink": {
      const conn: FrameLinkConnection = { ...profile.connection };
      if (!conn.port) conn.port = "120";
      return { ...profile, connection: conn };
    }
    case "slcan": {
      const conn: SlcanConnection = { ...profile.connection };
      if (!conn.baud_rate) conn.baud_rate = "115200";
      if (!conn.bitrate) conn.bitrate = "500000";
      if (conn.silent_mode === undefined) conn.silent_mode = true;
      return { ...profile, connection: conn };
    }
    case "socketcan": {
      const conn: SocketcanConnection = { ...profile.connection };
      if (!conn.interface) conn.interface = "can0";
      return { ...profile, connection: conn };
    }
    case "modbus_tcp": {
      const conn: ModbusTcpConnection = { ...profile.connection };
      if (!conn.host) conn.host = "192.168.1.100";
      if (!conn.port) conn.port = "502";
      if (!conn.unit_id) conn.unit_id = "1";
      return { ...profile, connection: conn };
    }
    case "serial": {
      const conn: SerialConnection = { ...profile.connection };
      if (!conn.baud_rate) conn.baud_rate = "115200";
      if (!conn.data_bits) conn.data_bits = "8";
      if (!conn.stop_bits) conn.stop_bits = "1";
      if (!conn.parity) conn.parity = "none";
      return { ...profile, connection: conn };
    }
    default:
      return profile;
  }
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

/** Message keys for the failures `validateProfileForm` can report. */
export type ProfileValidationError =
  | "nameRequired"
  | "nameDuplicate"
  | "portRequired"
  | "hostRequired";

/**
 * Check a profile form before it is saved or connected. Returns the failure, or
 * null when it is good. `existingNames` is the set of names already taken by
 * *other* profiles.
 */
export function validateProfileForm(
  profile: IOProfile,
  existingNames: Set<string>,
): ProfileValidationError | null {
  if (!profile.name.trim()) return "nameRequired";
  if (existingNames.has(profile.name)) return "nameDuplicate";
  if (profile.kind === "slcan" || profile.kind === "serial") {
    if (!profile.connection.port) return "portRequired";
  }
  if (profile.kind === "modbus_tcp" && !profile.connection.host) {
    return "hostRequired";
  }
  return null;
}
