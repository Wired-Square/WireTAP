// src/utils/profileTraits.ts
//
// How protocols and profile kinds are drawn. What a kind or profile can do is
// Rust's answer, served through `profileBusStore`.

import type { IOProfile } from "../hooks/useSettings";
import type { BadgeTone } from "../components/Badge";
import type { ModbusRegisterType } from "../api/io";
import type { Protocol } from "../generated/Protocol";

export type { Protocol };

/**
 * How each protocol is spelled on screen. One map so the source picker's per-bus
 * dropdown and the Data IO list agree — they read "CAN FD" and "CAN-FD" for the
 * same bus before this existed.
 */
export const PROTOCOL_LABELS: Record<Protocol, string> = {
  can: "CAN",
  canfd: "CAN-FD",
  modbus: "Modbus",
  modbus_rtu: "Modbus RTU",
  serial: "Serial",
};

/** A protocol's display label, falling back to the raw value for an unknown one. */
export function protocolLabel(protocol: string): string {
  return PROTOCOL_LABELS[protocol as Protocol] ?? protocol;
}

/** The hue a protocol's badge wears, the same on every screen that tags one. */
export const PROTOCOL_TONES: Record<Protocol, BadgeTone> = {
  can: "success",
  canfd: "cyan",
  modbus: "warning",
  modbus_rtu: "warning",
  serial: "purple",
};

export function protocolTone(protocol: string): BadgeTone {
  return PROTOCOL_TONES[protocol as Protocol] ?? "neutral";
}

/** The hue a Modbus register type's badge wears, in the Decoder and the catalogue tree alike. */
export const MODBUS_REGISTER_TONES: Record<ModbusRegisterType, BadgeTone> = {
  holding: "primary",
  input: "success",
  coil: "warning",
  discrete: "purple",
};

/**
 * Whether a frame of this protocol is one whole message off a line — a Modbus RTU
 * message with its CRC still on the end — rather than a frame with a payload. Such
 * a protocol gets its own Discovery tab, and its bytes show the check set apart.
 */
export function isMessageProtocol(protocol: string): boolean {
  return protocol === "modbus_rtu";
}

/** Trailing check bytes a message protocol carries; 0 where the frame has none. */
export function trailingCheckBytes(protocol: string | undefined): number {
  return protocol === "modbus_rtu" ? 2 : 0;
}

/**
 * The family a frame protocol belongs to for grouping: CAN FD frames share the
 * CAN tab and table, so a mixed classic/FD stream is one family.
 */
export function protocolFamily(protocol: string): string {
  return protocol === "canfd" ? "can" : protocol;
}

/** Profile kind type - all supported IO profile types */
export type ProfileKind = NonNullable<IOProfile["kind"]>;

/**
 * The protocols to *show* for a profile, as badges: CAN FD subsumes CAN, so a
 * device does not advertise both.
 */
export function displayProtocols(protocols: Protocol[] = []): Protocol[] {
  return protocols.includes("canfd") ? protocols.filter((p) => p !== "can") : protocols;
}

/**
 * Check if a profile answers time-range queries and carries a default playback
 * speed — what events and the Query app need.
 *
 * Deliberately a kind check rather than `temporalMode === "recorded"`: those
 * coincide only because the WireTAP backend is currently the sole recorded
 * kind. A file-backed recorded source would be recorded and not queryable.
 */
export function isTimeRangeCapableKind(kind: string | undefined): boolean {
  return kind === "wiretap";
}

/** Profiles that answer time-range queries. */
export function getTimeRangeCapableProfiles(profiles: IOProfile[]): IOProfile[] {
  return profiles.filter((p) => isTimeRangeCapableKind(p.kind));
}
