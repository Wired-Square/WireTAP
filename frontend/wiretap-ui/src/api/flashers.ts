// ui/src/api/flashers.ts
//
// Tauri command wrappers for the ESP32 (esptool-style), STM32 DFU, and
// STM32 UART (AN3155 system bootloader) firmware flashers. All three
// emit progress on the `flasher-progress` event channel — see
// src/apps/serial/utils/flasherTypes.ts for the payload.

import { invoke } from "@tauri-apps/api/core";
import type {
  DetectedChip,
  EspChipInfo,
  EspFlashOptions,
  DfuDeviceInfo,
  Stm32ChipInfo,
  Stm32FlashOptions,
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

// ---------------------------------------------------------------------------
// STM32 UART (AN3155 system bootloader)
// ---------------------------------------------------------------------------

export async function flasherStm32DetectChip(
  port: string,
  options?: Stm32FlashOptions,
): Promise<Stm32ChipInfo> {
  return invoke("flasher_stm32_detect_chip", { port, options });
}

export async function flasherStm32Flash(
  port: string,
  imagePath: string,
  address: number,
  options?: Stm32FlashOptions,
): Promise<string> {
  return invoke("flasher_stm32_flash", {
    port,
    image_path: imagePath,
    address,
    options,
  });
}

export async function flasherStm32ReadFlash(
  port: string,
  outputPath: string,
  offset: number,
  size: number | null,
  options?: Stm32FlashOptions,
): Promise<string> {
  return invoke("flasher_stm32_read_flash", {
    port,
    output_path: outputPath,
    offset,
    size,
    options,
  });
}

export async function flasherStm32Erase(
  port: string,
  options?: Stm32FlashOptions,
): Promise<string> {
  return invoke("flasher_stm32_erase", { port, options });
}

export async function flasherStm32Cancel(flashId: string): Promise<void> {
  await invoke("flasher_stm32_cancel", { flash_id: flashId });
}

// ---------------------------------------------------------------------------
// Unified chip-family detection
// ---------------------------------------------------------------------------

/**
 * Probe a serial port for any supported chip family. Tries STM32 AN3155
 * first (single 0x7F handshake, fast), then ESP esptool. Pass the user's
 * current STM32 pin map so detection uses their RTS/DTR wiring.
 */
export async function flasherSerialDetect(
  port: string,
  stm32Options?: Stm32FlashOptions,
): Promise<DetectedChip> {
  return invoke("flasher_serial_detect", {
    port,
    stm32_options: stm32Options,
  });
}
