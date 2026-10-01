// ui/src/apps/serial/utils/flasherTypes.ts
//
// Shared types for the ESP32 + STM32 DFU flashers. The chip-info shapes mirror
// `wslib-mcu-flash`, which exports no TypeScript.

import type { DetectedChip } from "../../../generated/DetectedChip";
import type { EspFlashOptions } from "../../../generated/EspFlashOptions";
import type { FlasherProgressEvent } from "../../../generated/FlasherProgressEvent";
import type { FlashPhase } from "../../../generated/FlashPhase";
import type { Stm32FlashOptions } from "../../../generated/Stm32FlashOptions";

export type {
  DetectedChip,
  EspFlashOptions,
  FlasherProgressEvent,
  FlashPhase,
  Stm32FlashOptions,
};

export interface EspChipInfo {
  chip: string;
  features: string[];
  mac: string;
  flash_size_bytes?: number | null;
}

export interface DfuDeviceInfo {
  vid: number;
  pid: number;
  serial: string;
  display_name: string;
  /** Chip-family badge string emitted by the backend. `"STM32 DFU"` for the
   *  ST ROM bootloader (VID 0x0483, PID 0xDF11); `"DFU"` for any other DFU
   *  device. Drives the manufacturer badge in the unified Flash view. */
  manufacturer: string;
}

/**
 * Result of an AN3155 GET + GET_ID handshake. PID is the 12-bit chip ID
 * returned by GET_ID; `chip` is our friendly name from the lookup table on
 * the Rust side. `rdp_level` is `"0"` if a 1-byte READ at the flash base
 * succeeded, `"1 (locked)"` if the chip rejected it.
 */
export interface Stm32ChipInfo {
  chip: string;
  pid: number;
  bootloader_version: string;
  flash_size_kb?: number | null;
  rdp_level?: string | null;
}

export type Stm32PinSelection = "rts" | "dtr" | "none";

