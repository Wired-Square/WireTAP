// ui/src/apps/modbus/stores/modbusStore.ts
//
// Zustand store for the Modbus app.
// Manages catalog/poll configuration, live register values, and decoded signals.

import { create } from 'zustand';
import { tlog } from '../../../api/settings';
import { loadCatalog as loadCatalogFromPath } from '../../../utils/catalogParser';
import { buildPollsFromCatalog, type ModbusPollGroup } from '../../../utils/modbusPollBuilder';
import { decodeSignal } from '../../../utils/signalDecode';
import { frameKey } from '../../../utils/frameKey';
import type { FrameMessage } from '../../../types/frame';
import type { SignalDef, FrameDetail } from '../../../types/decoder';
import type { ModbusProtocolConfig } from '../../../utils/catalogParser';

// ── Module-level mutables (avoids GC pressure from Zustand copies) ──

export type RegisterValue = {
  bytes: number[];
  decoded: DecodedSignalValue[];
  timestamp: number;
  pollIntervalMs?: number;
};

export type DecodedSignalValue = {
  name: string;
  value: string;
  unit?: string;
  rawValue?: number;
};

let _registerValues: Map<string, RegisterValue> = new Map();

/** Direct read-only access to register values (keyed by composite frame key). */
export function getRegisterValues(): Map<string, RegisterValue> {
  return _registerValues;
}

// ── Types ──

export type ModbusTransportMode = 'tcp' | 'rtu';

export type ModbusRtuConfig = {
  deviceAddress: number;
  validateCrc: boolean;
  responseTimeoutMs: number;
  interRequestDelayMs: number;
};

export type ModbusActiveTab = 'registers' | 'config';

interface ModbusState {
  // Catalog / poll configuration
  catalogPath: string | null;
  pollGroups: ModbusPollGroup[];
  modbusPollsJson: string | null;
  modbusConfig: ModbusProtocolConfig | null;
  /** Catalog frame definitions (composite-keyed) for signal decoding */
  frames: Map<string, FrameDetail>;

  // Transport mode
  transportMode: ModbusTransportMode;
  rtuConfig: ModbusRtuConfig;

  // Frame selection (composite keys, e.g. "modbus:5013")
  selectedFrames: Set<string>;

  // IO session
  ioProfile: string | null;

  // Register data reactivity
  registerVersion: number;

  // UI state
  activeTab: ModbusActiveTab;

  // Actions
  loadCatalog: (path: string) => Promise<void>;
  processFrames: (frames: FrameMessage[]) => void;
  setTransportMode: (mode: ModbusTransportMode) => void;
  setRtuConfig: (config: Partial<ModbusRtuConfig>) => void;
  setIoProfile: (profile: string | null) => void;
  setActiveTab: (tab: ModbusActiveTab) => void;
  toggleFrameSelection: (id: string) => void;
  selectAllFrames: () => void;
  deselectAllFrames: () => void;
  clearState: () => void;
}

export const useModbusStore = create<ModbusState>((set, get) => ({
  // Initial state
  catalogPath: null,
  pollGroups: [],
  modbusPollsJson: null,
  modbusConfig: null,
  frames: new Map(),
  selectedFrames: new Set(),
  transportMode: 'tcp',
  rtuConfig: {
    deviceAddress: 1,
    validateCrc: true,
    responseTimeoutMs: 1000,
    interRequestDelayMs: 50,
  },
  ioProfile: null,
  registerVersion: 0,
  activeTab: 'registers',

  loadCatalog: async (path: string) => {
    try {
      const catalog = await loadCatalogFromPath(path);

      // Build poll groups from Modbus frames
      const polls = buildPollsFromCatalog(catalog.frames, catalog.modbusConfig ?? null);
      const pollsJson = polls.length > 0 ? JSON.stringify(polls) : null;

      // Build frame definitions for signal decoding (composite-keyed)
      const frameMap = new Map<string, FrameDetail>();
      for (const [id, frame] of catalog.frames) {
        if (frame.protocol !== 'modbus') continue;
        const fk = frameKey('modbus', id);
        frameMap.set(fk, {
          id,
          len: frame.length,
          isExtended: false,
          bus: frame.bus,
          lenMismatch: false,
          signals: frame.signals as SignalDef[],
          mux: frame.mux,
          interval: frame.interval,
        });
      }

      // Apply default_word_order to signals without explicit word_order
      if (catalog.modbusConfig?.default_word_order) {
        const defaultWo = catalog.modbusConfig.default_word_order;
        for (const [, frame] of frameMap) {
          for (const signal of frame.signals) {
            if (!signal.word_order) signal.word_order = defaultWo;
          }
          if (frame.mux) {
            for (const caseDef of Object.values(frame.mux.cases ?? {})) {
              for (const signal of (caseDef as { signals: SignalDef[] }).signals) {
                if (!signal.word_order) signal.word_order = defaultWo;
              }
            }
          }
        }
      }

      tlog.info(`[modbusStore] Loaded catalog: ${path} — ${polls.length} poll groups, ${frameMap.size} frames`);

      set({
        catalogPath: path,
        pollGroups: polls,
        modbusPollsJson: pollsJson,
        modbusConfig: catalog.modbusConfig ?? null,
        frames: frameMap,
        selectedFrames: new Set(frameMap.keys()),
      });
    } catch (e) {
      tlog.info(`[modbusStore] Failed to load catalog: ${e}`);
      throw e;
    }
  },

  processFrames: (incomingFrames: FrameMessage[]) => {
    const { frames } = get();
    if (frames.size === 0) return;

    let changed = false;

    for (const f of incomingFrames) {
      if (f.protocol !== 'modbus') continue;

      const fk = frameKey('modbus', f.frame_id);
      const frameDef = frames.get(fk);
      if (!frameDef) continue;

      // Decode signals — Modbus defaults to big-endian
      const decoded: DecodedSignalValue[] = frameDef.signals.map((signal, idx) => {
        const result = decodeSignal(f.bytes, signal, signal.name || `Signal ${idx + 1}`, 'big');
        return {
          name: result.name,
          value: result.display,
          unit: result.unit,
          rawValue: result.value,
        };
      });

      _registerValues.set(fk, {
        bytes: f.bytes,
        decoded,
        timestamp: f.timestamp_us,
        pollIntervalMs: frameDef.interval,
      });
      changed = true;
    }

    if (changed) {
      set({ registerVersion: get().registerVersion + 1 });
    }
  },

  setTransportMode: (mode) => set({ transportMode: mode }),

  setRtuConfig: (config) => set((state) => ({
    rtuConfig: { ...state.rtuConfig, ...config },
  })),

  setIoProfile: (profile) => set({ ioProfile: profile }),

  setActiveTab: (tab) => set({ activeTab: tab }),

  toggleFrameSelection: (id) => {
    const { selectedFrames } = get();
    const next = new Set(selectedFrames);
    if (next.has(id)) {
      next.delete(id);
    } else {
      next.add(id);
    }
    set({ selectedFrames: next });
  },

  selectAllFrames: () => {
    const { frames } = get();
    set({ selectedFrames: new Set(frames.keys()) });
  },

  deselectAllFrames: () => {
    set({ selectedFrames: new Set() });
  },

  clearState: () => {
    _registerValues = new Map();
    set({
      registerVersion: get().registerVersion + 1,
    });
  },
}));
