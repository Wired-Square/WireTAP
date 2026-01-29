// src/api/gs_usb.ts
//
// API wrapper for gs_usb (candleLight) device commands.

import { invoke } from "@tauri-apps/api/core";

/**
 * Information about a detected gs_usb device.
 */
export interface GsUsbDeviceInfo {
  /** USB bus number */
  bus: number;
  /** USB device address */
  address: number;
  /** Product name from USB descriptor */
  product: string;
  /** Serial number (if available) */
  serial: string | null;
  /** SocketCAN interface name (Linux only, e.g., "can0") */
  interface_name: string | null;
  /** Whether the interface is currently up (Linux only) */
  interface_up: boolean | null;
}

/**
 * Result of probing a gs_usb device.
 */
export interface GsUsbProbeResult {
  success: boolean;
  /** Number of CAN channels on device */
  channel_count: number | null;
  /** Software version */
  sw_version: number | null;
  /** Hardware version */
  hw_version: number | null;
  /** CAN clock frequency */
  can_clock: number | null;
  /** Whether device supports CAN FD */
  supports_fd: boolean | null;
  /** Error message if probe failed */
  error: string | null;
}

/**
 * List all gs_usb devices connected to the system.
 * On Linux, includes the SocketCAN interface name if available.
 */
export async function listGsUsbDevices(): Promise<GsUsbDeviceInfo[]> {
  return invoke("list_gs_usb_devices");
}

/**
 * Generate the shell command to set up a CAN interface on Linux.
 * Returns the command the user should run with sudo.
 */
export async function getCanSetupCommand(
  interfaceName: string,
  bitrate: number
): Promise<string> {
  return invoke("get_can_setup_command", {
    interface: interfaceName,
    bitrate,
  });
}

/**
 * Probe a gs_usb device to get its capabilities.
 * Only available on Windows (Linux uses SocketCAN).
 */
export async function probeGsUsbDevice(
  bus: number,
  address: number
): Promise<GsUsbProbeResult> {
  return invoke("probe_gs_usb_device", { bus, address });
}

/**
 * Create a unique device ID for display and selection purposes.
 * Preference order: interface_name (Linux) > serial number > bus:address
 * Serial numbers are stable across USB reconnects, unlike bus:address.
 */
export function createDeviceId(device: GsUsbDeviceInfo): string {
  // Use interface name on Linux if available (most specific)
  if (device.interface_name) {
    return device.interface_name;
  }
  // Prefer serial number when available (stable across reconnects)
  if (device.serial) {
    return device.serial;
  }
  // Fall back to bus:address (may change on reconnect)
  return `${device.bus}:${device.address}`;
}

/**
 * Format a device for display in a dropdown.
 */
export function formatDeviceDisplay(device: GsUsbDeviceInfo): string {
  const parts = [device.product];

  if (device.serial) {
    parts.push(`(${device.serial})`);
  }

  if (device.interface_name) {
    const upStatus = device.interface_up ? "up" : "down";
    parts.push(`- ${device.interface_name} [${upStatus}]`);
  } else {
    parts.push(`- USB ${device.bus}:${device.address}`);
  }

  return parts.join(" ");
}
