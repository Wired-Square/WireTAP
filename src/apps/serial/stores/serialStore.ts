// src/apps/serial/stores/serialStore.ts
//
// Zustand store for the Serial app shell. Holds the user's chosen port,
// framing settings, active tab, and the DFU device list (read by both the
// SerialPortPicker and the Flash view). Flasher progress + driver state
// lives in `flasherStore.ts` — that store is the single source of truth
// for the unified Flash view.

import { create } from "zustand";

import type { DfuDeviceInfo } from "../utils/flasherTypes";

export type SerialTab = "terminal" | "flash";
export type Parity = "none" | "odd" | "even";

/** Which device the Flash view should target. Switches when the user picks
 *  a serial port (→ `"serial"`) or a DFU device (→ `"dfu"`) from the
 *  shared picker. The Terminal tab is always serial — this only affects
 *  the Flash tab's view of which device is active. */
export type FlashTarget = "serial" | "dfu";

export interface SerialSettings {
  port: string | null;
  baudRate: number;
  dataBits: 5 | 6 | 7 | 8;
  stopBits: 1 | 2;
  parity: Parity;
}

interface SerialState {
  settings: SerialSettings;
  activeTab: SerialTab;
  /** Echo typed characters locally (for devices that don't echo themselves). */
  localEcho: boolean;

  /** Last enumerated USB DFU devices + the currently selected one. The
   *  shared SerialPortPicker reads/writes both. The DFU device is
   *  identified by USB serial — stable across re-plug for STM32
   *  bootloaders, falls back to a synthetic `bus<N>-dev<M>` id otherwise. */
  dfuDevices: DfuDeviceInfo[];
  dfuSerial: string | null;
  /** Most recently selected device kind via the picker — drives the Flash
   *  view's "what am I flashing?" question. */
  flashTarget: FlashTarget;

  setSettings: (patch: Partial<SerialSettings>) => void;
  setPort: (port: string | null) => void;
  setActiveTab: (tab: SerialTab) => void;
  setLocalEcho: (echo: boolean) => void;
  setDfuDevices: (devices: DfuDeviceInfo[]) => void;
  setDfuSerial: (serial: string | null) => void;
  setFlashTarget: (target: FlashTarget) => void;
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

  dfuDevices: [],
  dfuSerial: null,
  flashTarget: "serial",

  setSettings: (patch) =>
    set((s) => ({ settings: { ...s.settings, ...patch } })),
  setPort: (port) => set((s) => ({ settings: { ...s.settings, port } })),
  setActiveTab: (activeTab) => set({ activeTab }),
  setLocalEcho: (localEcho) => set({ localEcho }),
  setDfuDevices: (dfuDevices) => set({ dfuDevices }),
  setDfuSerial: (dfuSerial) => set({ dfuSerial }),
  setFlashTarget: (flashTarget) => set({ flashTarget }),
}));
