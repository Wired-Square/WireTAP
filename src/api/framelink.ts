// src/api/framelink.ts
//
// FrameLink device API wrappers.

import { invoke } from "@tauri-apps/api/core";

export interface ProbeInterface {
  index: number;
  iface_type: number; // 1=CAN, 2=CANFD, 3=RS-485
  name: string;
  /** Human-readable interface type name from the protocol library. */
  type_name: string;
}

export interface FrameLinkProbeResult {
  device_id: string | null;
  board_name: string | null;
  board_revision: string | null;
  interfaces: ProbeInterface[];
}

/** Probe a FrameLink device and return its interfaces. */
export async function framelinkProbeDevice(
  host: string,
  port: number,
  timeout?: number,
): Promise<FrameLinkProbeResult> {
  return invoke("framelink_probe_device", { host, port, timeout });
}

// ============================================================================
// Signal Types
// ============================================================================

export interface SignalDescriptor {
  signal_id: number;
  name: string;
  group: string;
  unit: string;
  /** "bool", "enum", "number", "temperature_0.1", etc. */
  format: string;
  /** numeric_key → label (for enum signals) */
  enum_values: Record<string, string>;
  writable: boolean;
  persistable: boolean;
  value: number;
  formatted_value: string;
  /** Interface type: 1=CAN, 2=CANFD, 3=RS-485, 4=RS-232 */
  iface_type: number;
}

export interface SignalReadResult {
  signal_id: number;
  value: number;
  value_len: number;
}

// ============================================================================
// Signal API
// ============================================================================

/** Read all device signals for a given interface, enriched with board def metadata. */
export async function framelinkGetInterfaceSignals(
  deviceId: string,
  ifaceIndex: number,
  timeout?: number,
): Promise<SignalDescriptor[]> {
  return invoke("framelink_get_interface_signals", {
    device_id: deviceId,
    iface_index: ifaceIndex,
    timeout,
  });
}

/** Write a device signal value, with optional persist. */
export async function framelinkWriteSignal(
  deviceId: string,
  signalId: number,
  value: number,
  persist: boolean,
  timeout?: number,
): Promise<void> {
  return invoke("framelink_write_signal", {
    device_id: deviceId,
    signal_id: signalId,
    value,
    persist,
    timeout,
  });
}

/** Read a single device signal value. */
export async function framelinkReadSignal(
  deviceId: string,
  signalId: number,
  timeout?: number,
): Promise<SignalReadResult> {
  return invoke("framelink_read_signal", {
    device_id: deviceId,
    signal_id: signalId,
    timeout,
  });
}
