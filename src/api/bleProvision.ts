// ui/src/api/bleProvision.ts
// BLE WiFi Provisioning API wrappers

import { invoke } from "@tauri-apps/api/core";

// ============================================================================
// Types
// ============================================================================

export interface BleDevice {
  name: string;
  id: string;
  rssi: number | null;
}

export interface DeviceWifiState {
  ssid: string | null;
  security: number | null;
  status: number;
  ip_address: string | null;
}

export interface WifiCredentials {
  ssid: string;
  passphrase: string | null;
  security: number;
}

export interface ProvisioningStatus {
  status: string;
  status_code: number;
}

// ============================================================================
// Constants
// ============================================================================

/** Open network (no passphrase) */
export const SECURITY_OPEN = 0;
/** WPA2-PSK (requires passphrase) */
export const SECURITY_WPA2_PSK = 2;

export const STATUS_DISCONNECTED = 0;
export const STATUS_CONNECTING = 1;
export const STATUS_CONNECTED = 2;
export const STATUS_ERROR = 3;

// ============================================================================
// Commands
// ============================================================================

/** Start scanning for BLE devices with the WiFi provisioning service. */
export async function bleScanStart(): Promise<void> {
  await invoke("ble_scan_start");
}

/** Stop an active BLE scan. */
export async function bleScanStop(): Promise<void> {
  await invoke("ble_scan_stop");
}

/** Connect to a BLE device by its platform-specific ID. */
export async function bleConnect(deviceId: string): Promise<void> {
  await invoke("ble_connect", { deviceId });
}

/** Disconnect from the currently connected BLE device. */
export async function bleDisconnect(): Promise<void> {
  await invoke("ble_disconnect");
}

/** Delete all stored WiFi credentials on the connected device. */
export async function bleDeleteAllCredentials(): Promise<void> {
  await invoke("ble_delete_all_credentials");
}

/** Disconnect the device from its current WiFi network. */
export async function bleWifiDisconnect(): Promise<void> {
  await invoke("ble_wifi_disconnect");
}

/** Read the current WiFi state from the connected device. */
export async function bleReadDeviceState(): Promise<DeviceWifiState> {
  return invoke("ble_read_device_state");
}

/** Write WiFi credentials and send the save+connect command. */
export async function bleProvisionWifi(credentials: WifiCredentials): Promise<void> {
  await invoke("ble_provision_wifi", { credentials });
}

/** Subscribe to status notifications from the connected device. */
export async function bleSubscribeStatus(): Promise<void> {
  await invoke("ble_subscribe_status");
}

/** Detect the host machine's current WiFi SSID (returns null on iOS). */
export async function bleGetHostWifiSsid(): Promise<string | null> {
  return invoke("ble_get_host_wifi_ssid");
}
