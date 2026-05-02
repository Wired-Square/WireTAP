// ui/src/apps/serial/stores/serialStore.ts
//
// Zustand store for the Serial app. Holds the user's chosen port, framing
// settings, active tab, and per-tab flasher progress.

import { create } from "zustand";

import type {
  EspChipInfo,
  EspFlashOptions,
} from "../utils/flasherTypes";

export type SerialTab = "terminal" | "esp" | "dfu";
export type Parity = "none" | "odd" | "even";
export type EspOperation = "flash" | "backup" | "erase";

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

  setSettings: (patch) =>
    set((s) => ({ settings: { ...s.settings, ...patch } })),
  setPort: (port) =>
    set((s) => ({
      settings: { ...s.settings, port },
      // A new port means our cached detection is no longer valid.
      espChip: port === s.settings.port ? s.espChip : null,
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
}));
