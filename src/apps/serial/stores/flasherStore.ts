// src/apps/serial/stores/flasherStore.ts
//
// Zustand store backing the unified Flash view. One store regardless of
// chip family — the active driver id flips when the user picks a different
// device, and only one flash/backup/erase runs at a time across the whole
// app. Each driver owns its own option slice (esp / stm32 / dfu) so the
// per-driver OptionsPanel can read+write its own config without leaking
// fields between chip families.

import { create } from "zustand";

import type { DriverId, Operation } from "../flashers/types";
import type {
  EspFlashOptions,
  Stm32FlashOptions,
} from "../utils/flasherTypes";

export type FlashPhase =
  | "idle"
  | "connecting"
  | "erasing"
  | "writing"
  | "verifying"
  | "done"
  | "error"
  | "cancelled";

export interface FlashProgress {
  flashId: string | null;
  phase: FlashPhase;
  bytesDone: number;
  bytesTotal: number;
  log: string[];
  error: string | null;
}

export const initialFlashProgress: FlashProgress = {
  flashId: null,
  phase: "idle",
  bytesDone: 0,
  bytesTotal: 0,
  log: [],
  error: null,
};

/** Detected chip — drives the status bar and the active driver. `raw`
 *  carries the driver-specific chip-info struct (`EspChipInfo`,
 *  `Stm32ChipInfo`, …) so the OptionsPanel can default off it. */
export interface DetectedChipState {
  driverId: DriverId;
  manufacturer: string;
  chipName: string;
  flashSizeKb?: number | null;
  raw: unknown;
}

/** Default flasher options — match the user's typical flow on this hardware. */
const DEFAULT_ESP_OPTIONS: EspFlashOptions = {
  chip: null,
  flash_baud: 921_600,
  flash_mode: "dio",
  flash_freq: "80MHz",
  flash_size: null,
};

/** stm32flash convention with the common "DTR=BOOT0, RTS=NRST (active low)"
 *  wiring. Override per-board if the transistor wiring differs. */
const DEFAULT_STM32_OPTIONS: Stm32FlashOptions = {
  boot0_pin: "dtr",
  reset_pin: "rts",
  boot0_invert: false,
  reset_invert: true,
  baud: 115_200,
};

interface FlasherState {
  /** Driver currently driving the Flash view. `null` = empty state. */
  activeDriverId: DriverId | null;
  /** Active sub-mode (Flash / Backup / Erase) within the chosen driver. */
  operation: Operation;
  /** Last successful chip detection. `null` until detected (or after a
   *  device disconnect). */
  chip: DetectedChipState | null;
  /** Single shared progress channel — only one op runs at a time. */
  flash: FlashProgress;

  /** Per-driver option slices. */
  espOptions: EspFlashOptions;
  stm32Options: Stm32FlashOptions;

  setActiveDriver: (id: DriverId | null) => void;
  setOperation: (op: Operation) => void;
  setChip: (chip: DetectedChipState | null) => void;
  setFlash: (patch: Partial<FlashProgress>) => void;
  appendLog: (line: string) => void;
  resetFlash: () => void;

  setEspOptions: (patch: Partial<EspFlashOptions>) => void;
  setStm32Options: (patch: Partial<Stm32FlashOptions>) => void;
}

export const useFlasherStore = create<FlasherState>((set) => ({
  activeDriverId: null,
  operation: "flash",
  chip: null,
  flash: { ...initialFlashProgress },

  espOptions: { ...DEFAULT_ESP_OPTIONS },
  stm32Options: { ...DEFAULT_STM32_OPTIONS },

  setActiveDriver: (activeDriverId) => set({ activeDriverId }),
  setOperation: (operation) => set({ operation }),
  setChip: (chip) => set({ chip }),
  setFlash: (patch) => set((s) => ({ flash: { ...s.flash, ...patch } })),
  appendLog: (line) =>
    set((s) => ({ flash: { ...s.flash, log: [...s.flash.log, line] } })),
  resetFlash: () => set({ flash: { ...initialFlashProgress } }),

  setEspOptions: (patch) =>
    set((s) => ({ espOptions: { ...s.espOptions, ...patch } })),
  setStm32Options: (patch) =>
    set((s) => ({ stm32Options: { ...s.stm32Options, ...patch } })),
}));
