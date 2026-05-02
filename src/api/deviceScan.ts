// ui/src/api/deviceScan.ts
// Unified device scan API wrappers

import { invoke } from "@tauri-apps/api/core";

// ============================================================================
// Types
// ============================================================================

export interface UnifiedDevice {
  name: string;
  /** Device name with unique hardware suffix (e.g. "WiredFlexLink-9D04") */
  id: string;
  /** "ble", "udp", or "tcp" */
  transport: "ble" | "udp" | "tcp";
  /** BLE peripheral ID (needed for BLE connections, absent for mDNS-only) */
  ble_id: string | null;
  /** BLE only */
  rssi: number | null;
  /** mDNS only: IP address */
  address: string | null;
  /** mDNS only: port number */
  port: number | null;
  /** Capabilities: "wifi-provision", "smp", "framelink" */
  capabilities: string[];
  /** Frontend-only: ms since epoch the entry was last refreshed by a discovery event. */
  lastSeenAt?: number;
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
