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

export interface DfuDeviceInfo {
  vid: number;
  pid: number;
  serial: string;
  display_name: string;
}
