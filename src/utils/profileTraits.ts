// src/utils/profileTraits.ts
//
// Centralised profile trait registry for platform compatibility,
// temporal modes, protocols, and capabilities.
//
// This is the single source of truth for all profile capabilities.

import type { IOProfile, GvretInterfaceConfig } from "../hooks/useSettings";
import type { BusMapping } from "../api/io";

// ============================================================================
// Types
// ============================================================================

/** Supported platforms */
export type Platform = "windows" | "macos" | "linux" | "ios";

/** Temporal mode - realtime (live streaming) or timeline (recorded data) */
export type TemporalMode = "realtime" | "timeline";

/** Protocol type - determines frame format and compatibility */
export type Protocol = "can" | "canfd" | "modbus" | "serial";

/** Profile kind type - all supported IO profile types */
export type ProfileKind = NonNullable<IOProfile["kind"]>;

/** Complete traits for a profile kind */
export interface ProfileTraits {
  temporalMode: TemporalMode;
  protocols: Protocol[];
  canTransmit: boolean;
  platforms: Platform[];
  multiSource: boolean;
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
  },
  gvret_usb: {
    temporalMode: "realtime",
    protocols: ["can"],
    canTransmit: true,
    platforms: ["windows", "macos", "linux"], // No iOS (requires serial port)
    multiSource: true,
  },
  serial: {
    temporalMode: "realtime",
    protocols: ["serial"],
    canTransmit: false,
    platforms: ["windows", "macos", "linux"], // No iOS (requires serial port)
    multiSource: true,
  },
  slcan: {
    temporalMode: "realtime",
    protocols: ["can"],
    canTransmit: true,
    platforms: ["windows", "macos", "linux"], // No iOS (requires serial port)
    multiSource: true,
  },
  gs_usb: {
    temporalMode: "realtime",
    protocols: ["can"],
    canTransmit: true,
    platforms: ["windows", "macos"], // Linux uses SocketCAN kernel driver, no iOS
    multiSource: true,
  },
  socketcan: {
    temporalMode: "realtime",
    protocols: ["can"],
    canTransmit: true,
    platforms: ["linux"], // Linux kernel only
    multiSource: true,
  },
  mqtt: {
    temporalMode: "realtime",
    protocols: ["can"],
    canTransmit: false,
    platforms: ["windows", "macos", "linux", "ios"],
    multiSource: true,
  },
  postgres: {
    temporalMode: "timeline",
    protocols: ["can"], // Can also be modbus/serial depending on source_type
    canTransmit: false,
    platforms: ["windows", "macos", "linux", "ios"],
    multiSource: false,
  },
  csv_file: {
    temporalMode: "timeline",
    protocols: ["can"],
    canTransmit: false,
    platforms: ["windows", "macos", "linux", "ios"],
    multiSource: false,
  },
  modbus_tcp: {
    temporalMode: "realtime",
    protocols: ["modbus"],
    canTransmit: false,
    platforms: ["windows", "macos", "linux", "ios"],
    multiSource: true,
  },
  virtual: {
    temporalMode: "realtime",
    protocols: ["can"],
    canTransmit: true,
    platforms: ["windows", "macos", "linux", "ios"],
    multiSource: true,
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
  const c = profile.connection;

  switch (profile.kind) {
    case "virtual":
      return getVirtualProfileTraits(profile);

    case "slcan":
    case "gs_usb":
    case "socketcan":
      if (c?.enable_fd) traits.protocols = ["can", "canfd"];
      break;

    case "gvret_tcp":
    case "gvret_usb": {
      const ifaces = c?.interfaces as GvretInterfaceConfig[] | undefined;
      if (ifaces?.some((i) => i.protocol === "canfd")) {
        traits.protocols = ["can", "canfd"];
      }
      break;
    }

    case "postgres":
      switch (c?.source_type) {
        case "modbus_frame":
          traits.protocols = ["modbus"];
          break;
        case "serial_frame":
        case "serial_raw":
          traits.protocols = ["serial"];
          break;
      }
      break;
  }

  return traits;
}

/**
 * Derive virtual adapter traits from profile connection config.
 * The traffic_type determines which protocols the virtual device uses.
 */
function getVirtualProfileTraits(profile: IOProfile): ProfileTraits {
  const base = { ...PROFILE_TRAIT_REGISTRY.virtual };
  switch (profile.connection?.traffic_type as string | undefined) {
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
 * Get all profile kinds available on a given platform.
 */
export function getAvailableProfileKinds(platform: Platform): ProfileKind[] {
  return (Object.keys(PROFILE_TRAIT_REGISTRY) as ProfileKind[]).filter(
    (kind) => PROFILE_TRAIT_REGISTRY[kind].platforms.includes(platform)
  );
}

// ============================================================================
// Trait Query Functions
// ============================================================================

/**
 * Check if a profile is realtime (live data source).
 */
export function isRealtimeProfile(profile: IOProfile): boolean {
  const traits = getProfileTraits(profile);
  return traits?.temporalMode === "realtime";
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

// ============================================================================
// Bus Mapping Helpers
// ============================================================================

/**
 * Build a default BusMapping array for a single profile.
 * Used when routing a single realtime source through the multi-source session path
 * so that `generateMultiSessionId` can determine the correct session ID prefix.
 */
export function buildDefaultBusMappings(profile: IOProfile): BusMapping[] {
  const traits = getProfileTraits(profile);
  const protocol = traits?.protocols[0] ?? "can";
  return [{
    deviceBus: 0,
    enabled: true,
    outputBus: 0,
    interfaceId: `${protocol}0`,
    traits: {
      temporal_mode: "realtime",
      protocols: (protocol === "can" ? ["can", "canfd"] : [protocol]) as Protocol[],
      tx_frames: traits?.canTransmit ?? false,
      tx_bytes: false,
      multi_source: traits?.multiSource ?? true,
    },
  }];
}
