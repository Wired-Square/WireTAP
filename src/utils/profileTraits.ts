// src/utils/profileTraits.ts
//
// Centralised profile trait registry for platform compatibility,
// temporal modes, protocols, and capabilities.
//
// This is the single source of truth for all profile capabilities.

import type { IOProfile } from "../hooks/useSettings";

// ============================================================================
// Types
// ============================================================================

/** Supported platforms */
export type Platform = "windows" | "macos" | "linux" | "ios";

/** Temporal mode - realtime (live streaming) or recorded (recorded data) */
export type TemporalMode = "realtime" | "recorded";

/** Protocol type - determines frame format and compatibility */
export type Protocol = "can" | "canfd" | "modbus" | "modbus_rtu" | "serial";

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

/** Profile kind type - all supported IO profile types */
export type ProfileKind = NonNullable<IOProfile["kind"]>;

/** Complete traits for a profile kind */
export interface ProfileTraits {
  temporalMode: TemporalMode;
  protocols: Protocol[];
  canTransmit: boolean;
  platforms: Platform[];
  multiSource: boolean;
  /** Whether this kind can have multiple device-level buses/interfaces */
  hasDeviceBuses: boolean;
}

/** Validation result when combining interfaces */
export interface TraitValidation {
  valid: boolean;
  error?: string;
}

// For backward compatibility with existing code expecting InterfaceTraits
export type InterfaceTraits = Pick<ProfileTraits, "temporalMode" | "protocols" | "canTransmit" | "multiSource">;

// ============================================================================
// Trait Registry
// ============================================================================

/**
 * Central registry of traits for each profile kind.
 * This is the single source of truth for profile capabilities.
 */
const PROFILE_TRAIT_REGISTRY: Record<ProfileKind, ProfileTraits> = {
  gvret_tcp: {
    temporalMode: "realtime",
    protocols: ["can"],
    canTransmit: true,
    platforms: ["windows", "macos", "linux", "ios"],
    multiSource: true,
    hasDeviceBuses: true,
  },
  gvret_usb: {
    temporalMode: "realtime",
    protocols: ["can"],
    canTransmit: true,
    platforms: ["windows", "macos", "linux"], // No iOS (requires serial port)
    multiSource: true,
    hasDeviceBuses: true,
  },
  serial: {
    temporalMode: "realtime",
    protocols: ["serial"],
    canTransmit: false,
    platforms: ["windows", "macos", "linux"], // No iOS (requires serial port)
    multiSource: true,
    hasDeviceBuses: false,
  },
  slcan: {
    temporalMode: "realtime",
    protocols: ["can"],
    canTransmit: true,
    platforms: ["windows", "macos", "linux"], // No iOS (requires serial port)
    multiSource: true,
    hasDeviceBuses: false,
  },
  gs_usb: {
    temporalMode: "realtime",
    protocols: ["can"],
    canTransmit: true,
    platforms: ["windows", "macos"], // Linux uses SocketCAN kernel driver, no iOS
    multiSource: true,
    hasDeviceBuses: false,
  },
  socketcan: {
    temporalMode: "realtime",
    protocols: ["can"],
    canTransmit: true,
    platforms: ["linux"], // Linux kernel only
    multiSource: true,
    hasDeviceBuses: false,
  },
  mqtt: {
    temporalMode: "realtime",
    protocols: ["can"],
    canTransmit: false,
    platforms: ["windows", "macos", "linux", "ios"],
    multiSource: true,
    hasDeviceBuses: false,
  },
  wiretap: {
    temporalMode: "recorded",
    protocols: ["can"],
    canTransmit: false,
    platforms: ["windows", "macos", "linux", "ios"],
    multiSource: false,
    hasDeviceBuses: false,
  },
  modbus_tcp: {
    temporalMode: "realtime",
    protocols: ["modbus"],
    canTransmit: false,
    platforms: ["windows", "macos", "linux", "ios"],
    multiSource: true,
    hasDeviceBuses: false,
  },
  framelink: {
    temporalMode: "realtime",
    protocols: ["can"], // Refined per-interface by getProfileTraits()
    canTransmit: true,
    platforms: ["windows", "macos", "linux", "ios"],
    multiSource: true,
    hasDeviceBuses: true,
  },
  virtual: {
    temporalMode: "realtime",
    protocols: ["can"],
    canTransmit: true,
    platforms: ["windows", "macos", "linux", "ios"],
    multiSource: true,
    hasDeviceBuses: true,
  },
};

// ============================================================================
// Trait Lookup Functions
// ============================================================================

/**
 * Get traits for a profile kind.
 * Returns undefined if the kind is not in the registry.
 */
export function getTraitsForKind(kind: ProfileKind): ProfileTraits | undefined {
  return PROFILE_TRAIT_REGISTRY[kind];
}

/**
 * Get traits for a profile, with config-aware protocol detection.
 * Returns undefined if the profile has no kind or kind is not in registry.
 *
 * The static registry provides base defaults. This function overrides
 * protocols based on connection config for devices that support CAN-FD
 * or multiple protocol modes.
 */
export function getProfileTraits(profile: IOProfile): ProfileTraits | undefined {
  if (!profile.kind) return undefined;
  const base = PROFILE_TRAIT_REGISTRY[profile.kind];
  if (!base) return undefined;
  const traits = { ...base };

  switch (profile.kind) {
    case "virtual":
      return getVirtualProfileTraits(profile);

    case "slcan":
      if (profile.connection?.enable_fd) traits.protocols = ["can", "canfd"];
      break;
    case "gs_usb":
      if (profile.connection?.enable_fd) traits.protocols = ["can", "canfd"];
      break;
    case "socketcan":
      if (profile.connection?.enable_fd) traits.protocols = ["can", "canfd"];
      break;

    case "gvret_tcp":
    case "gvret_usb": {
      const ifaces = profile.connection?.interfaces;
      if (ifaces?.some((i) => i.protocol === "canfd")) {
        traits.protocols = ["can", "canfd"];
      }
      break;
    }

    case "framelink": {
      const interfaces = profile.connection?.interfaces;
      if (interfaces && interfaces.length > 0) {
        // Grouped profile — derive protocols from all interfaces
        const protocols: Protocol[] = [];
        const hasCan = interfaces.some((i) => i.iface_type === 1 || i.iface_type === 2);
        const hasCanFd = interfaces.some((i) => i.iface_type === 2);
        const hasSerial = interfaces.some((i) => i.iface_type === 3);
        if (hasCan) protocols.push("can");
        if (hasCanFd) protocols.push("canfd");
        if (hasSerial) protocols.push("serial");
        if (protocols.length > 0) traits.protocols = protocols;
      } else {
        // Legacy single-interface fallback
        const ifaceType = profile.connection?.interface_type;
        if (ifaceType === 3) traits.protocols = ["serial"];
        else if (ifaceType === 2) traits.protocols = ["can", "canfd"];
      }
      break;
    }

  }

  return traits;
}

/**
 * Derive virtual adapter traits from profile connection config.
 * The traffic_type determines which protocols the virtual device uses.
 */
function getVirtualProfileTraits(profile: Extract<IOProfile, { kind: "virtual" }>): ProfileTraits {
  const base = { ...PROFILE_TRAIT_REGISTRY.virtual };
  switch (profile.connection?.traffic_type) {
    case "canfd":
      base.protocols = ["can", "canfd"];
      break;
    case "modbus":
      base.protocols = ["modbus"];
      base.canTransmit = false;
      break;
    case "serial":
      base.protocols = ["serial"];
      break;
    default: // "can" or unset
      break;
  }
  return base;
}

// ============================================================================
// Platform Availability Functions
// ============================================================================

/**
 * Check if a profile kind is available on a given platform.
 */
export function isKindAvailableOnPlatform(kind: ProfileKind, platform: Platform): boolean {
  const traits = getTraitsForKind(kind);
  return traits?.platforms.includes(platform) ?? false;
}

/**
 * Check if a profile is available on a given platform.
 */
export function isProfileAvailableOnPlatform(profile: IOProfile, platform: Platform): boolean {
  if (!profile.kind) return false;
  return isKindAvailableOnPlatform(profile.kind, platform);
}

/**
 * The order profile kinds are offered in, roughly alphabetical by display name.
 * Kept explicit so every kind picker — Settings and the source picker's device
 * editor — lists them the same way, rather than in registry declaration order.
 *
 * A `Record`, not an array: a new kind added to `ProfileKind` and forgotten here
 * would otherwise vanish from every kind picker with no compile error, and so
 * be unaddable from the UI.
 */
const PROFILE_KIND_DISPLAY_ORDER: Record<ProfileKind, number> = {
  framelink: 0,
  gs_usb: 1,
  gvret_tcp: 2,
  gvret_usb: 3,
  modbus_tcp: 4,
  mqtt: 5,
  wiretap: 6,
  serial: 7,
  slcan: 8,
  socketcan: 9,
  virtual: 10,
};

/**
 * Get all profile kinds available on a given platform, in display order.
 */
export function getAvailableProfileKinds(platform: Platform): ProfileKind[] {
  return (Object.keys(PROFILE_TRAIT_REGISTRY) as ProfileKind[])
    .filter((kind) => PROFILE_TRAIT_REGISTRY[kind].platforms.includes(platform))
    .sort((a, b) => PROFILE_KIND_DISPLAY_ORDER[a] - PROFILE_KIND_DISPLAY_ORDER[b]);
}

// ============================================================================
// Trait Query Functions
// ============================================================================

/**
 * The protocol a single-bus device's one bus carries.
 *
 * Multi-bus sources read this off the `BusMapping` Rust hands them; a single-bus
 * source has no mapping to read, so it is derived here from the same traits.
 *
 * Deliberately not `getReaderProtocols(...)[0]`, which this replaced: that
 * function drops base `"can"` whenever `"canfd"` is present *for display*, so
 * its first element was only incidentally the right answer. A change to how the
 * badges render would have silently downgraded every FD session to classic CAN.
 */
export function busProtocol(profile: IOProfile | undefined): Protocol {
  const protocols = (profile && getProfileTraits(profile)?.protocols) || [];
  // CAN FD subsumes CAN, so it wins when a device declares both.
  if (protocols.includes("canfd")) return "canfd";
  return protocols[0] ?? "can";
}

/**
 * The protocols to *show* for a profile, as badges.
 *
 * Same CAN-FD-subsumes-CAN rule as `busProtocol`, applied for a different
 * purpose: that one picks the single protocol a bus runs as, this one trims a
 * list so a device does not advertise both CAN and CAN FD. Kept beside it
 * because the two used to state the rule in different files, and the session
 * path was reading the display answer.
 */
export function displayProtocols(profile: IOProfile): Protocol[] {
  const protocols = getProfileTraits(profile)?.protocols ?? [];
  if (protocols.includes("canfd")) return protocols.filter((p) => p !== "can");
  return protocols.length > 0 ? protocols : ["can"];
}

/**
 * Check if a profile is realtime (live data source).
 */
export function isRealtimeProfile(profile: IOProfile): boolean {
  const traits = getProfileTraits(profile);
  return traits?.temporalMode === "realtime";
}

/**
 * Check if a profile answers time-range queries and carries a default playback
 * speed — what bookmarks and the Query app need.
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

/**
 * Check if a profile supports multi-source (multi-bus) mode.
 */
export function isMultiSourceCapable(profile: IOProfile): boolean {
  const traits = getProfileTraits(profile);
  return traits?.multiSource ?? false;
}

/**
 * Check if a profile can transmit frames.
 */
export function canTransmit(profile: IOProfile): boolean {
  const traits = getProfileTraits(profile);
  return traits?.canTransmit ?? false;
}

/**
 * Check if a profile has multiple device-level buses/interfaces.
 * Uses the static hasDeviceBuses trait plus dynamic config (interface count).
 *
 * GVRET stays unconditionally multi-bus: `probe_device` reports every GVRET as
 * multi-bus, and the picker keys which config map holds a source off this
 * answer. Disagreeing with the probe would split a one-bus GVRET's state across
 * both maps. Which buses a profile actually has — and how many — comes from
 * `profileBusStore`, not from here.
 */
export function isMultiBusProfile(profile: IOProfile): boolean {
  if (!profile.kind) return false;
  const base = PROFILE_TRAIT_REGISTRY[profile.kind];
  if (!base?.hasDeviceBuses) return false;

  switch (profile.kind) {
    case "gvret_tcp":
    case "gvret_usb":
      return true; // Always multi-bus (hardware interfaces)
    case "framelink": {
      const interfaces = profile.connection?.interfaces;
      return Array.isArray(interfaces) && interfaces.length > 1;
    }
    case "virtual": {
      const interfaces = profile.connection?.interfaces;
      return Array.isArray(interfaces) && interfaces.length > 1;
    }
    default:
      return false;
  }
}

// ============================================================================
// Multi-Source Validation
// ============================================================================

/** Protocol compatibility groups - protocols in the same group can be combined */
function getProtocolGroup(protocol: Protocol): number {
  switch (protocol) {
    case "can":
    case "canfd":
      return 0; // CAN group
    case "modbus":
    case "modbus_rtu":
      return 1;
    case "serial":
      return 2;
    default:
      return -1;
  }
}

/** Check if two protocol sets are compatible */
function areProtocolsCompatible(a: Protocol[], b: Protocol[]): boolean {
  if (a.length === 0 || b.length === 0) return true;

  const aGroups = new Set(a.map(getProtocolGroup));
  const bGroups = new Set(b.map(getProtocolGroup));

  for (const group of aGroups) {
    if (bGroups.has(group)) return true;
  }
  return false;
}

/**
 * Validate if a profile can be added to a selection of profiles.
 */
export function validateProfileSelection(
  selectedProfiles: IOProfile[],
  newProfile: IOProfile
): TraitValidation {
  if (selectedProfiles.length === 0) {
    return { valid: true };
  }

  const newTraits = getProfileTraits(newProfile);
  if (!newTraits) {
    return { valid: false, error: "Unknown profile type" };
  }

  // Check temporal mode compatibility
  const existingTraits = selectedProfiles
    .map(getProfileTraits)
    .filter((t): t is ProfileTraits => t !== undefined);

  if (existingTraits.length === 0) {
    return { valid: true };
  }

  const existingMode = existingTraits[0].temporalMode;

  if (newTraits.temporalMode !== existingMode) {
    return {
      valid: false,
      error: `Cannot mix ${existingMode} and ${newTraits.temporalMode} sources`,
    };
  }

  // Sources with multiSource: false cannot be combined
  if (!newTraits.multiSource) {
    return {
      valid: false,
      error: `${newProfile.kind} does not support multi-source sessions`,
    };
  }

  // Check protocol compatibility
  const existingProtocols = existingTraits.flatMap((t) => t.protocols);
  if (!areProtocolsCompatible(existingProtocols, newTraits.protocols)) {
    return {
      valid: false,
      error: `Incompatible protocols: ${newTraits.protocols.join("/")} cannot be combined with ${[...new Set(existingProtocols)].join("/")}`,
    };
  }

  return { valid: true };
}
