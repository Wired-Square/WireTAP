// src/utils/busFormat.ts
//
// Utility functions for formatting bus labels.

/** Source info for a bus in multi-bus mode */
export interface BusSourceInfo {
  profileName: string;
  deviceBus: number;
  /** The device behind this bus, so the UI can offer to reconfigure it. */
  profileId: string;
}

/**
 * Format a bus label for display.
 * Shows "outputBus: ProfileName" where ProfileName comes from multi-bus mapping if available.
 *
 * @param profileName - The profile/source name (fallback for single-source mode)
 * @param bus - The output bus number (null/undefined for serial)
 * @param outputBusToSource - Optional mapping for multi-bus mode
 * @returns Formatted label like "0: Sungrow Goulburn" or just "ProfileName" for serial
 */
export function formatBusLabel(
  profileName: string,
  bus: number | null | undefined,
  outputBusToSource?: Map<number, BusSourceInfo>
): string {
  if (bus === null || bus === undefined) {
    return profileName;
  }

  // Use source profile name from multi-bus mapping if available
  const sourceInfo = outputBusToSource?.get(bus);
  const displayName = sourceInfo?.profileName ?? profileName;

  return `${bus}: ${displayName}`;
}

/**
 * Get the device bus number for an output bus in multi-bus mode.
 *
 * @param bus - The output bus number
 * @param outputBusToSource - The multi-bus mapping
 * @returns The device bus number, or null if not in multi-bus mode
 */
export function getDeviceBus(
  bus: number | null | undefined,
  outputBusToSource?: Map<number, BusSourceInfo>
): number | null {
  if (bus === null || bus === undefined) {
    return null;
  }
  return outputBusToSource?.get(bus)?.deviceBus ?? null;
}
