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
  isMultiSourceCapable: boolean;
}

/** Validation result when combining interfaces */
export interface TraitValidation {
  valid: boolean;
  error?: string;
}

// For backward compatibility with existing code expecting InterfaceTraits
export type InterfaceTraits = Pick<ProfileTraits, "temporalMode" | "protocols" | "canTransmit">;

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
    isMultiSourceCapable: true,
  },
  gvret_usb: {
    temporalMode: "realtime",
    protocols: ["can"],
    canTransmit: true,
    platforms: ["windows", "macos", "linux"], // No iOS (requires serial port)
    isMultiSourceCapable: true,
  },
  serial: {
    temporalMode: "realtime",
    protocols: ["serial"],
    canTransmit: false,
    platforms: ["windows", "macos", "linux"], // No iOS (requires serial port)
    isMultiSourceCapable: true,
  },
  slcan: {
    temporalMode: "realtime",
    protocols: ["can"],
    canTransmit: true,
    platforms: ["windows", "macos", "linux"], // No iOS (requires serial port)
    isMultiSourceCapable: true,
  },
  gs_usb: {
    temporalMode: "realtime",
    protocols: ["can"],
    canTransmit: true,
    platforms: ["windows", "macos"], // Linux uses SocketCAN kernel driver, no iOS
    isMultiSourceCapable: true,
  },
  socketcan: {
    temporalMode: "realtime",
    protocols: ["can"],
    canTransmit: true,
    platforms: ["linux"], // Linux kernel only
    isMultiSourceCapable: true,
  },
  mqtt: {
    temporalMode: "realtime",
    protocols: ["can"],
    canTransmit: false,
    platforms: ["windows", "macos", "linux", "ios"],
    isMultiSourceCapable: true,
  },
  postgres: {
    temporalMode: "timeline",
    protocols: ["can"], // Can also be modbus/serial depending on source_type
    canTransmit: false,
    platforms: ["windows", "macos", "linux", "ios"],
    isMultiSourceCapable: false,
  },
  csv_file: {
    temporalMode: "timeline",
    protocols: ["can"],
    canTransmit: false,
    platforms: ["windows", "macos", "linux", "ios"],
    isMultiSourceCapable: false,
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
 * Get traits for a profile.
 * Returns undefined if the profile has no kind or kind is not in registry.
 */
export function getProfileTraits(profile: IOProfile): ProfileTraits | undefined {
  if (!profile.kind) return undefined;
  return getTraitsForKind(profile.kind);
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
  return traits?.isMultiSourceCapable ?? false;
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

  // Timeline sources can only have 1 interface
  if (newTraits.temporalMode === "timeline") {
    return {
      valid: false,
      error: "Timeline sources cannot be combined (single interface only)",
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

  // Check if the new profile supports multi-source
  if (!newTraits.isMultiSourceCapable) {
    return {
      valid: false,
      error: `${newProfile.kind} does not support multi-bus mode`,
    };
  }

  return { valid: true };
}
