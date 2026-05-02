// ui/src/api/flashers.ts
//
// Tauri command wrappers for the ESP32 (esptool-style) and STM32 DFU
// firmware flashers. Both flashers emit progress on the `flasher-progress`
// event channel — see src/apps/serial/utils/flasherTypes.ts for the payload.

import { invoke } from "@tauri-apps/api/core";
import type {
  EspChipInfo,
  DfuDeviceInfo,
} from "../apps/serial/utils/flasherTypes";

export const FLASHER_PROGRESS_EVENT = "flasher-progress";

export async function flasherEspDetectChip(
  port: string,
  baud: number,
): Promise<EspChipInfo> {
  return invoke("flasher_esp_detect_chip", { port, baud });
}

export async function flasherEspFlash(
  port: string,
  baud: number,
  imagePath: string,
  address: number,
): Promise<string> {
  return invoke("flasher_esp_flash", {
    port,
    baud,
    image_path: imagePath,
    address,
  });
}

export async function flasherEspCancel(flashId: string): Promise<void> {
  await invoke("flasher_esp_cancel", { flash_id: flashId });
}

export async function flasherDfuListDevices(): Promise<DfuDeviceInfo[]> {
  return invoke("flasher_dfu_list_devices");
}

export async function flasherDfuFlash(
  usbSerial: string,
  imagePath: string,
  address: number,
): Promise<string> {
  return invoke("flasher_dfu_flash", {
    usb_serial: usbSerial,
    image_path: imagePath,
    address,
  });
}

export async function flasherDfuCancel(flashId: string): Promise<void> {
  await invoke("flasher_dfu_cancel", { flash_id: flashId });
}
