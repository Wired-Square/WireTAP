// ui/src/apps/serial/utils/flasherTypes.ts
//
// Shared types for the ESP32 + STM32 DFU flashers. Mirror of the Rust
// payload structures emitted on the `flasher-progress` Tauri event.

export type FlashPhase =
  | "connecting"
  | "erasing"
  | "writing"
  | "verifying"
  | "done"
  | "error"
  | "cancelled";

export interface FlasherProgressEvent {
  flash_id: string;
  phase: FlashPhase;
  bytes_done: number;
  bytes_total: number;
  message?: string;
}

export interface EspChipInfo {
  chip: string;
  features: string[];
  mac: string;
  flash_size_bytes?: number | null;
}

/**
 * Tuning knobs passed to the ESP flasher. All optional — omit a field (or
 * leave it as `null`/`"auto"`) to let espflash decide.
 *
 * Mirrors the `EspFlashOptions` struct on the Rust side.
 */
export interface EspFlashOptions {
  /** Forced chip (`esp32`, `esp32s3`, …). Omit/null = auto-detect. */
  chip?: string | null;
  /** Bootloader baud rate. Omit = 460_800. */
  flash_baud?: number | null;
  /** Flash mode (`dio`/`qio`/`qout`/`dout`). */
  flash_mode?: string | null;
  /** Flash frequency (`40MHz`/`80MHz`/`26MHz`/`20MHz`). */
  flash_freq?: string | null;
  /** Flash size (`4MB`/`8MB`/`16MB`/…). */
  flash_size?: string | null;
}

export interface DfuDeviceInfo {
  vid: number;
  pid: number;
  serial: string;
  display_name: string;
}
