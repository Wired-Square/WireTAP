// ui/src/utils/modbusProfiles.ts
//
// Small predicates over IO profiles that several apps need when deciding
// whether Modbus polling applies to a session.

import { useMemo } from "react";
import { useSettingsStore } from "../apps/settings/stores/settingsStore";
import type { IOProfile } from "../settings/appSettings";

/** The profile kind that carries Modbus polling. */
export const MODBUS_PROFILE_KIND = "modbus_tcp";

/** A Modbus profile, narrowed out of the profile-kind union. */
export type ModbusProfile = Extract<IOProfile, { kind: "modbus_tcp" }>;

/** Session-id prefix for a discovery sweep, as opposed to a polling session. */
export const MODBUS_SCAN_SESSION_PREFIX = "m_scan";

/** What `ModbusScanSource::source_type()` reports for a sweep. */
export const MODBUS_SCAN_SOURCE_TYPE = "modbus_scan";

/**
 * Whether this session is a sweep rather than a poller.
 *
 * A sweep reports `Protocol::Modbus` too — that is what keeps the tools lit while
 * its results are in view — so protocol alone cannot tell the two apart, and the
 * poll switch has to address the poller, not the sweep that borrowed the screen.
 *
 * `sourceType` is the authoritative answer and comes off the session roster. The
 * id prefix stays as the fallback for one reason: Discovery mints a scan session
 * id and joins it before the roster reconcile lands, so `sourceType` is undefined
 * for a beat — and during that beat the switch would un-latch. Note that the
 * prefix is *not* shared with Rust: `mcp/tools.rs` formats `"m_scan{}"` of its
 * own accord, so the two agree by convention.
 */
export function isModbusScanSession(sessionId: string, sourceType?: string): boolean {
  return sourceType !== undefined
    ? sourceType === MODBUS_SCAN_SOURCE_TYPE
    : sessionId.startsWith(MODBUS_SCAN_SESSION_PREFIX);
}

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

/** What a Modbus address falls back to with no profile to read one off. */
export const MODBUS_DEFAULT_CONNECTION: ModbusConnection = {
  host: "127.0.0.1",
  port: 502,
  unit_id: 1,
};

/** What **Custom** means: no device named, but the fields with real defaults keep them. */
export const MODBUS_BLANK_CONNECTION: ModbusConnection = { ...MODBUS_DEFAULT_CONNECTION, host: "" };

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

/** Host/port/unit from a Modbus profile's connection map, with the usual defaults. */
export function modbusConnectionOf(
  profile: HasModbusConnection | undefined | null
): ModbusConnection {
  return {
    host: String(profile?.connection?.host ?? MODBUS_DEFAULT_CONNECTION.host),
    port: Number(profile?.connection?.port) || MODBUS_DEFAULT_CONNECTION.port,
    unit_id: Number(profile?.connection?.unit_id) || MODBUS_DEFAULT_CONNECTION.unit_id,
  };
}
