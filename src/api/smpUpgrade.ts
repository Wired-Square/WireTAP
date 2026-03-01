// API wrappers for SMP firmware upgrade Tauri commands

import { invoke } from "@tauri-apps/api/core";

// Types

export interface ImageSlotInfo {
  slot: number;
  version: string;
  hash: string;
  bootable: boolean;
  pending: boolean;
  confirmed: boolean;
  active: boolean;
  permanent: boolean;
  image: number | null;
}

export interface UploadProgress {
  bytes_sent: number;
  total_bytes: number;
  percent: number;
}

/** Unified device type for both BLE and mDNS-discovered devices. */
export interface DiscoveredDevice {
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
  /** mDNS service type (e.g. "_mcumgr._udp") */
  service_type: string | null;
}

// Scanning

export async function smpScanStart(): Promise<void> {
  await invoke("smp_scan_start");
}

export async function smpScanStop(): Promise<void> {
  await invoke("smp_scan_stop");
}

// Connection

export async function smpConnectBle(deviceId: string): Promise<void> {
  await invoke("smp_connect_ble", { deviceId });
}

/** Attach SMP to the already-connected provisioning BLE peripheral (no adapter lookup). */
export async function smpAttachBle(): Promise<void> {
  await invoke("smp_attach_ble");
}

export async function smpConnectUdp(address: string, port: number): Promise<void> {
  await invoke("smp_connect_udp", { address, port });
}

export async function smpDisconnect(): Promise<void> {
  await invoke("smp_disconnect");
}

// Image management

export async function smpListImages(): Promise<ImageSlotInfo[]> {
  return invoke("smp_list_images");
}

export async function smpUploadFirmware(filePath: string, image?: number): Promise<void> {
  await invoke("smp_upload_firmware", { filePath, image: image ?? null });
}

export async function smpTestImage(hash: number[]): Promise<void> {
  await invoke("smp_test_image", { hash });
}

export async function smpConfirmImage(hash: number[]): Promise<void> {
  await invoke("smp_confirm_image", { hash });
}

export async function smpResetDevice(): Promise<void> {
  await invoke("smp_reset_device");
}

export async function smpCancelUpload(): Promise<void> {
  await invoke("smp_cancel_upload");
}
