// ui/src/apps/serial/stores/serialStore.ts
//
// Zustand store for the Serial app. Holds the user's chosen port, framing
// settings, active tab, and per-tab flasher progress.

import { create } from "zustand";

import type {
  EspChipInfo,
  EspFlashOptions,
  Stm32ChipInfo,
  Stm32FlashOptions,
} from "../utils/flasherTypes";

export type SerialTab = "terminal" | "esp" | "dfu" | "stm32";
export type Parity = "none" | "odd" | "even";
export type EspOperation = "flash" | "backup" | "erase";
export type Stm32Operation = "flash" | "backup" | "erase";

export interface SerialSettings {
  port: string | null;
  baudRate: number;
  dataBits: 5 | 6 | 7 | 8;
  stopBits: 1 | 2;
  parity: Parity;
}

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

/** Default flasher options — match the user's typical flow on this hardware. */
const DEFAULT_ESP_OPTIONS: EspFlashOptions = {
  chip: null,
  flash_baud: 921_600,
  flash_mode: "dio",
  flash_freq: "80MHz",
  flash_size: null,
};

/** Default STM32 UART flasher options — stm32flash convention with the
 * common "DTR=BOOT0, RTS=NRST (active low)" wiring. */
const DEFAULT_STM32_OPTIONS: Stm32FlashOptions = {
  boot0_pin: "dtr",
  reset_pin: "rts",
  boot0_invert: false,
  reset_invert: true,
  baud: 115_200,
};

interface SerialState {
  settings: SerialSettings;
  activeTab: SerialTab;
  /** Echo typed characters locally (for devices that don't echo themselves). */
  localEcho: boolean;
  espFlash: FlashProgress;
  dfuFlash: FlashProgress;

  /** Sub-mode within the ESP Flash tab (write / dump / wipe). */
  espOperation: EspOperation;
  /** Persistent flasher knobs, shared across operations. */
  espOptions: EspFlashOptions;
  /** Last successful chip detection. Populates the status bar + flash size default. */
  espChip: EspChipInfo | null;

  /** Per-tab progress + state for the STM32 UART flasher. */
  stm32Flash: FlashProgress;
  stm32Operation: Stm32Operation;
  stm32Options: Stm32FlashOptions;
  stm32Chip: Stm32ChipInfo | null;

  // actions
  setSettings: (patch: Partial<SerialSettings>) => void;
  setPort: (port: string | null) => void;
  setActiveTab: (tab: SerialTab) => void;
  setLocalEcho: (echo: boolean) => void;
  setEspFlash: (patch: Partial<FlashProgress>) => void;
  setDfuFlash: (patch: Partial<FlashProgress>) => void;
  appendEspLog: (line: string) => void;
  appendDfuLog: (line: string) => void;
  resetEspFlash: () => void;
  resetDfuFlash: () => void;
  setEspOperation: (op: EspOperation) => void;
  setEspOptions: (patch: Partial<EspFlashOptions>) => void;
  setEspChip: (chip: EspChipInfo | null) => void;
  setStm32Flash: (patch: Partial<FlashProgress>) => void;
  appendStm32Log: (line: string) => void;
  resetStm32Flash: () => void;
  setStm32Operation: (op: Stm32Operation) => void;
  setStm32Options: (patch: Partial<Stm32FlashOptions>) => void;
  setStm32Chip: (chip: Stm32ChipInfo | null) => void;
}

export const useSerialStore = create<SerialState>((set) => ({
  settings: {
    port: null,
    baudRate: 115200,
    dataBits: 8,
    stopBits: 1,
    parity: "none",
  },
  activeTab: "terminal",
  localEcho: false,
  espFlash: { ...initialFlashProgress },
  dfuFlash: { ...initialFlashProgress },
  espOperation: "flash",
  espOptions: { ...DEFAULT_ESP_OPTIONS },
  espChip: null,

  stm32Flash: { ...initialFlashProgress },
  stm32Operation: "flash",
  stm32Options: { ...DEFAULT_STM32_OPTIONS },
  stm32Chip: null,

  setSettings: (patch) =>
    set((s) => ({ settings: { ...s.settings, ...patch } })),
  setPort: (port) =>
    set((s) => ({
      settings: { ...s.settings, port },
      // A new port means our cached detection is no longer valid.
      espChip: port === s.settings.port ? s.espChip : null,
      stm32Chip: port === s.settings.port ? s.stm32Chip : null,
    })),
  setActiveTab: (activeTab) => set({ activeTab }),
  setLocalEcho: (localEcho) => set({ localEcho }),
  setEspFlash: (patch) => set((s) => ({ espFlash: { ...s.espFlash, ...patch } })),
  setDfuFlash: (patch) => set((s) => ({ dfuFlash: { ...s.dfuFlash, ...patch } })),
  appendEspLog: (line) =>
    set((s) => ({ espFlash: { ...s.espFlash, log: [...s.espFlash.log, line] } })),
  appendDfuLog: (line) =>
    set((s) => ({ dfuFlash: { ...s.dfuFlash, log: [...s.dfuFlash.log, line] } })),
  resetEspFlash: () => set({ espFlash: { ...initialFlashProgress } }),
  resetDfuFlash: () => set({ dfuFlash: { ...initialFlashProgress } }),
  setEspOperation: (espOperation) => set({ espOperation }),
  setEspOptions: (patch) =>
    set((s) => ({ espOptions: { ...s.espOptions, ...patch } })),
  setEspChip: (espChip) => set({ espChip }),
  setStm32Flash: (patch) =>
    set((s) => ({ stm32Flash: { ...s.stm32Flash, ...patch } })),
  appendStm32Log: (line) =>
    set((s) => ({ stm32Flash: { ...s.stm32Flash, log: [...s.stm32Flash.log, line] } })),
  resetStm32Flash: () => set({ stm32Flash: { ...initialFlashProgress } }),
  setStm32Operation: (stm32Operation) => set({ stm32Operation }),
  setStm32Options: (patch) =>
    set((s) => ({ stm32Options: { ...s.stm32Options, ...patch } })),
  setStm32Chip: (stm32Chip) => set({ stm32Chip }),
}));
