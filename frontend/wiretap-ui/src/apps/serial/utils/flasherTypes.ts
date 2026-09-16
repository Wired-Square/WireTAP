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
  /** Chip-family badge string emitted by the backend. `"STM32 DFU"` for the
   *  ST ROM bootloader (VID 0x0483, PID 0xDF11); `"DFU"` for any other DFU
   *  device. Drives the manufacturer badge in the unified Flash view. */
  manufacturer: string;
}

/** Unified detection result returned by `flasher_serial_detect`. */
export interface DetectedChip {
  /** Driver registry id — `"esp-uart"` or `"stm32-uart"`. */
  driver_id: string;
  /** Manufacturer badge string — `"ESP32"`, `"ESP8266"`, `"STM32"`. */
  manufacturer: string;
  /** Friendly chip name (`"ESP32-S3"`, `"STM32F103"`, …). */
  chip_name: string;
  /** Flash size in KB if known. */
  flash_size_kb?: number | null;
  /** Original chip-info struct (`EspChipInfo` or `Stm32ChipInfo`) so the
   *  driver-specific UI can render extra fields (MAC, RDP, …). */
  extra: unknown;
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

/**
 * Tuning knobs for the STM32 UART flasher. Mirror of the `Stm32FlashOptions`
 * struct on the Rust side. Defaults (DTR=BOOT0, RTS=NRST, NRST inverted)
 * match the stm32flash convention; override per-board if your transistor
 * wiring differs.
 */
export interface Stm32FlashOptions {
  /** Pin driving BOOT0. Default `"dtr"`. */
  boot0_pin?: Stm32PinSelection | null;
  /** Pin driving NRST. Default `"rts"`. */
  reset_pin?: Stm32PinSelection | null;
  /** Invert BOOT0 polarity. Default `false`. */
  boot0_invert?: boolean | null;
  /** Invert RESET polarity. Default `true` (active-low NRST). */
  reset_invert?: boolean | null;
  /** Bootloader baud (1200..=115200). Default 115200. */
  baud?: number | null;
}
