// ui/src/api/deviceScan.ts
// Unified device scan API wrappers

import { invoke } from "@tauri-apps/api/core";

// ============================================================================
// Types
// ============================================================================

export interface UnifiedDevice {
  name: string;
  /** BLE: peripheral ID string, UDP: "udp:address:port" */
  id: string;
  /** "ble" or "udp" */
  transport: "ble" | "udp";
  /** BLE only */
  rssi: number | null;
  /** UDP only: IP address */
  address: string | null;
  /** UDP only: port number */
  port: number | null;
  /** Capabilities: "wifi-provision", "smp" */
  capabilities: string[];
}

// ============================================================================
// Commands
// ============================================================================

/** Start scanning for BLE and mDNS devices. */
export function deviceScanStart(): Promise<void> {
  return invoke("device_scan_start");
}

/** Stop an active scan. */
export function deviceScanStop(): Promise<void> {
  return invoke("device_scan_stop");
}
