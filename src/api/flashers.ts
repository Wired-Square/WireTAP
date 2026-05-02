// ui/src/api/flashers.ts
//
// Tauri command wrappers for the ESP32 (esptool-style) and STM32 DFU
// firmware flashers. Both flashers emit progress on the `flasher-progress`
// event channel — see src/apps/serial/utils/flasherTypes.ts for the payload.

import { invoke } from "@tauri-apps/api/core";
import type {
  EspChipInfo,
  EspFlashOptions,
  DfuDeviceInfo,
} from "../apps/serial/utils/flasherTypes";

export const FLASHER_PROGRESS_EVENT = "flasher-progress";

export async function flasherEspDetectChip(
  port: string,
  options?: EspFlashOptions,
): Promise<EspChipInfo> {
  return invoke("flasher_esp_detect_chip", { port, options });
}

export async function flasherEspFlash(
  port: string,
  imagePath: string,
  address: number,
  options?: EspFlashOptions,
): Promise<string> {
  return invoke("flasher_esp_flash", {
    port,
    image_path: imagePath,
    address,
    options,
  });
}

export async function flasherEspReadFlash(
  port: string,
  outputPath: string,
  offset: number,
  size: number | null,
  options?: EspFlashOptions,
): Promise<string> {
  return invoke("flasher_esp_read_flash", {
    port,
    output_path: outputPath,
    offset,
    size,
    options,
  });
}

export async function flasherEspErase(
  port: string,
  options?: EspFlashOptions,
): Promise<string> {
  return invoke("flasher_esp_erase", { port, options });
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
