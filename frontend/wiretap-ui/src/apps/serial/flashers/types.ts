// src/apps/serial/flashers/types.ts
//
// Driver-agnostic types for the unified Flash view. A `FlasherDriver` is a
// plain record describing one chip family — adding support for a new CPU
// (RP2040, nRF DFU, …) is one new entry in `flashers/registry.ts`, no
// changes to the view, store, or hand-off logic required.

import type { ComponentType } from "react";
import type { Manufacturer } from "../../../components/ManufacturerBadge";

/** Where the device lives — drives picker mode and Tauri command shape. */
export type Transport = "serial" | "dfu";

/** Driver registry id. Stable string keys so the store can persist and so
 *  the backend's `flasher_serial_detect` command can name the winner. */
export type DriverId = "esp-uart" | "stm32-uart" | "stm32-dfu";

/** Flash operation modes — every driver supports a subset (see `capabilities`). */
export type Operation = "flash" | "backup" | "erase";

/** What the driver was given to flash — either a serial port path (`port`)
 *  or a USB serial string (`serial`). The driver picks the variant it needs. */
export type DeviceHandle =
  | { kind: "serial"; port: string }
  | { kind: "dfu"; serial: string };

/** What the driver can do. Used by the unified view to disable the
 *  Backup/Erase buttons when the active driver doesn't implement them. */
export interface DriverCapabilities {
  flash: boolean;
  backup: boolean;
  erase: boolean;
}

/** Args passed to a driver's `flash` action. */
export interface FlashArgs {
  imagePath: string;
  /** Flash address. Drivers that take addresses from the image (`.hex`,
   *  `.dfu`) can ignore this. */
  address: number;
}

/** Args passed to a driver's `backup` action. */
export interface BackupArgs {
  outputPath: string;
  offset: number;
  /** `null` means "full chip" — the driver is expected to figure out the
   *  size from the detected chip info, or fail with a clear message. */
  size: number | null;
}

/** A one-line description of a detected chip, for the status bar. */
export interface ChipDescription {
  /** Primary line — chip name + key fact (e.g. `"STM32F103 · 64 KB flash"`). */
  label: string;
  /** Optional secondary line shown in muted text underneath. */
  subline?: string;
}

/** Props passed to every driver's `OptionsPanel`. The panel reads/writes
 *  its own option slice from the flasher store directly — only the chip
 *  is threaded through, so panels can default fields off detected info. */
export interface DriverOptionsPanelProps<C> {
  chip: C | null;
}

/**
 * One chip family. The unified Flash view reads everything it needs from
 * this — the active driver record drives the entire UI.
 */
export interface FlasherDriver<C = unknown> {
  id: DriverId;
  manufacturer: Manufacturer;
  transport: Transport;
  capabilities: DriverCapabilities;
  /** Driver-specific options panel rendered above the operation form. The
   *  panel manages its own option slice via `useFlasherStore`. */
  OptionsPanel: ComponentType<DriverOptionsPanelProps<C>>;
  /** Kick off a flash. Returns the backend `flashId` for progress wiring. */
  flash: (handle: DeviceHandle, args: FlashArgs) => Promise<string>;
  /** Kick off a backup. Optional — drivers without this capability omit it. */
  backup?: (handle: DeviceHandle, args: BackupArgs) => Promise<string>;
  /** Kick off an erase. Optional — same as backup. */
  erase?: (handle: DeviceHandle) => Promise<string>;
  /** Cancel an in-flight operation. Always implemented. */
  cancel: (flashId: string) => Promise<void>;
  /** Render a human-friendly chip summary for the status bar. */
  describeChip: (chip: C) => ChipDescription;
  /** Default starting flash address for the operation pickers (e.g.
   *  `0x08000000` for STM32, `0x0` for ESP32). */
  defaultFlashAddress: number;
  /** File extensions accepted by the open dialog (without leading dot). */
  imageExtensions: string[];
  /** Default file extension for backup dumps. */
  backupExtension: string;
}
