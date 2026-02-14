// ui/src/api/serial.ts
//
// API wrapper for serial port operations

import { invoke } from "@tauri-apps/api/core";

/** Information about an available serial port */
export interface SerialPortInfo {
  port_name: string;
  port_type: string; // "USB", "Bluetooth", "PCI", "Unknown"
  manufacturer: string | null;
  product: string | null;
  serial_number: string | null;
  vid: number | null; // USB Vendor ID
  pid: number | null; // USB Product ID
}

/** Result from probing a serial device (slcan, GVRET USB, etc.) */
export interface DeviceProbeResponse {
  /** Whether the probe was successful (device responded) */
  success: boolean;
  /** Firmware version string (if available) */
  version: string | null;
  /** Hardware version string (if available) */
  hardware_version: string | null;
  /** Serial number (if available) */
  serial_number: string | null;
  /** Error message (if probe failed) */
  error: string | null;
}

/**
 * List all available serial ports on the system.
 * Returns port information including USB device details where available.
 */
export async function listSerialPorts(): Promise<SerialPortInfo[]> {
  return invoke("platform_list_serial_ports");
}

/** Optional serial framing parameters for probing */
export interface SerialFramingOptions {
  /** Data bits (5, 6, 7, 8) - defaults to 8 */
  dataBits?: number;
  /** Stop bits (1, 2) - defaults to 1 */
  stopBits?: number;
  /** Parity ("none", "odd", "even") - defaults to "none" */
  parity?: string;
}

/**
 * Probe an slcan device (CANable, etc.) to check if it's responding and get version info.
 * This opens the port briefly, sends version query commands, and closes it.
 *
 * @param port - Serial port path (e.g., "/dev/cu.usbmodem1101", "COM3")
 * @param baudRate - Serial baud rate (typically 115200 for CANable)
 * @param framing - Optional serial framing parameters (defaults to 8N1)
 * @returns Probe result with success status and version info
 */
export async function probeSlcanDevice(
  port: string,
  baudRate: number,
  framing?: SerialFramingOptions
): Promise<DeviceProbeResponse> {
  return invoke("platform_probe_slcan_device", {
    port,
    baudRate,
    dataBits: framing?.dataBits,
    stopBits: framing?.stopBits,
    parity: framing?.parity,
  });
}
