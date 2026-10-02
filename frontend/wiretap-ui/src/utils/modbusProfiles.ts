// ui/src/utils/modbusProfiles.ts
//
// Small predicates over IO profiles that several apps need when deciding
// whether Modbus polling applies to a session.

import { useMemo } from "react";
import { useSettingsStore } from "../apps/settings/stores/settingsStore";
import type { IOProfile } from "../settings/appSettings";
import type { ConnectionDefaults } from "../api/deviceKinds";

/** The profile kind that carries Modbus polling. */
export const MODBUS_PROFILE_KIND = "modbus_tcp";

/** A Modbus profile, narrowed out of the profile-kind union. */
export type ModbusProfile = Extract<IOProfile, { kind: "modbus_tcp" }>;

/**
 * Just enough of a profile to read an address off it.
 *
 * Two `IOProfile` types are in play — the settings union and the lighter one in
 * `types/common` that several apps pass around — and both carry the same
 * connection fields. Accepting the shape rather than either name lets callers
 * use whichever they already hold.
 */
type HasModbusConnection = {
  connection?: { host?: unknown; port?: unknown; unit_id?: unknown };
};

/**
 * True if any of these profiles is a Modbus source — the only kind polls apply to.
 *
 * Reads the store imperatively rather than through a selector on purpose: this
 * is a decision made inside callbacks, and subscribing would re-render every
 * consumer whenever any unrelated profile changed.
 */
export function anyModbusProfile(profileIds: string[]): boolean {
  const profiles = useSettingsStore.getState().ioProfiles.profiles;
  return profileIds.some((id) => profiles.find((p) => p.id === id)?.kind === MODBUS_PROFILE_KIND);
}

function isModbusProfile(p: IOProfile): p is ModbusProfile {
  return p.kind === MODBUS_PROFILE_KIND;
}

/** Every configured Modbus profile. */
export function useModbusProfiles(): ModbusProfile[] {
  const profiles = useSettingsStore((s) => s.ioProfiles.profiles);
  return useMemo(() => profiles.filter(isModbusProfile), [profiles]);
}

/** A Modbus device address. */
export interface ModbusConnection {
  host: string;
  port: number;
  unit_id: number;
}

/** What **Custom** means: no device named, but the protocol's own port and unit. */
export const MODBUS_BLANK_CONNECTION: ModbusConnection = { host: "", port: 502, unit_id: 1 };

/**
 * The Modbus session whose poller the top bar's switch drives.
 *
 * Identity only — no address. The scan tools name their own device through
 * `useModbusTarget`, so nothing reads a host off this; carrying one would just
 * be a second place for the device to be described.
 */
export interface ModbusPollerRef {
  sessionId: string;
  profileId: string;
  /** Profile display name, for naming the device on screen. */
  name: string;
}

/** Host/port/unit from a Modbus profile's connection map, blanks read from the kind's `defaults`. */
export function modbusConnectionOf(
  profile: HasModbusConnection | undefined | null,
  defaults: ConnectionDefaults,
): ModbusConnection {
  return {
    host: String(profile?.connection?.host || defaults.host || ""),
    port: Number(profile?.connection?.port) || Number(defaults.port),
    unit_id: Number(profile?.connection?.unit_id) || Number(defaults.unit_id),
  };
}
