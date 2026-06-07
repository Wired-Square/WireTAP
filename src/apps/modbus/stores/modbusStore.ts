// ui/src/apps/modbus/stores/modbusStore.ts
//
// Zustand store for the Modbus app.
// Manages catalog/poll configuration, live register values, and decoded signals.

import { create } from 'zustand';
import { tlog } from '../../../api/settings';
import { openCatalog, parseCatalog } from '../../../api/catalog';
import type { Catalog } from '../../../types/catalogModel';
import { buildPollsFromCatalog, type ModbusPollGroup } from '../../../utils/modbusPollBuilder';
import { frameKey } from '../../../utils/frameKey';
import type { FrameMessage } from '../../../types/frame';
import type { DecodedFrameMsg } from '../../../services/wsProtocol';
import type { SignalDef, FrameDetail } from '../../../types/decoder';
import type { ModbusProtocolConfig, ResolvedFrame, ResolvedSignal } from '../../../utils/catalogParser';

/**
 * Convert the resolved unified catalogue (from the shared `wiretap-catalog`
 * crate via the `catalog.parse` WS command, with both Modbus authoring
 * shorthands already applied) into the `ResolvedFrame` map the rest of the
 * store consumes. Maps the crate's camelCase model onto the frontend's
 * snake_case `ResolvedSignal`; `Frame.length` is already a byte length.
 */
function catalogToModbusFrames(
  cat: Catalog,
): { frames: Map<number, ResolvedFrame>; modbusConfig: ModbusProtocolConfig } {
  const m = cat.modbus;
  const modbusConfig: ModbusProtocolConfig = {
    device_address: m?.deviceAddress,
    register_base: m?.registerBase === 1 ? 1 : 0,
    default_interval: m?.defaultInterval,
    default_byte_order: m?.defaultByteOrder,
    default_word_order: m?.defaultWordOrder,
  };
  const frames = new Map<number, ResolvedFrame>();
  for (const f of cat.frames) {
    if (f.protocol !== 'modbus') continue;
    frames.set(f.frameId, {
      frameId: f.frameId,
      protocol: 'modbus',
      name: f.name,
      length: f.length,
      interval: f.interval,
      modbusRegisterType: f.modbusRegisterType,
      modbusRegisterCount: f.modbusRegisterCount,
      signals: f.signals.map((s): ResolvedSignal => ({
        name: s.name,
        start_bit: s.startBit,
        bit_length: s.bitLength,
        signed: s.signed,
        endianness: s.endianness,
        word_order: s.wordOrder,
        factor: s.factor,
        offset: s.offset,
        unit: s.unit,
        format: s.format && s.format !== 'other' ? s.format : undefined,
        enum: (s.enum ?? undefined) as Record<number, string> | undefined,
      })),
    });
  }
  return { frames, modbusConfig };
}

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
  applyDecoded: (decoded: DecodedFrameMsg[]) => void;
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
      // Parse via the shared Rust crate (catalog.parse over the WS) so the
      // register-from-key and signal-less-register shorthands are resolved
      // before we build anything.
      const content = await openCatalog(path);
      const cat = await parseCatalog(content);
      const { frames: resolvedFrames, modbusConfig } = catalogToModbusFrames(cat);

      // Build poll groups from Modbus frames
      const polls = buildPollsFromCatalog(resolvedFrames, modbusConfig);
      const pollsJson = polls.length > 0 ? JSON.stringify(polls) : null;

      // Build frame definitions for signal decoding (composite-keyed)
      const frameMap = new Map<string, FrameDetail>();
      for (const [id, frame] of resolvedFrames) {
        frameMap.set(frameKey('modbus', id), {
          id,
          name: frame.name,
          len: frame.length,
          isExtended: false,
          lenMismatch: false,
          signals: frame.signals as SignalDef[],
          interval: frame.interval,
        });
      }

      // The frontend decoder reads word order per-signal, so fold the meta
      // default into signals that don't set their own.
      if (modbusConfig.default_word_order) {
        const defaultWo = modbusConfig.default_word_order;
        for (const [, frame] of frameMap) {
          for (const signal of frame.signals) {
            if (!signal.word_order) signal.word_order = defaultWo;
          }
        }
      }

      tlog.info(`[modbusStore] Loaded catalog: ${path} — ${polls.length} poll groups, ${frameMap.size} frames`);

      set({
        catalogPath: path,
        pollGroups: polls,
        modbusPollsJson: pollsJson,
        modbusConfig,
        frames: frameMap,
        selectedFrames: new Set(frameMap.keys()),
      });
    } catch (e) {
      tlog.info(`[modbusStore] Failed to load catalog: ${e}`);
      throw e;
    }
  },

  // Store the raw register bytes per frame. Decoding happens once in Rust and
  // arrives via the DecodedSignals stream (see applyDecoded) — this keeps the
  // Raw column live and preserves any decoded values already received.
  processFrames: (incomingFrames: FrameMessage[]) => {
    const { frames } = get();
    if (frames.size === 0) return;

    let changed = false;

    for (const f of incomingFrames) {
      if (f.protocol !== 'modbus') continue;

      const fk = frameKey('modbus', f.frame_id);
      const frameDef = frames.get(fk);
      if (!frameDef) continue;

      const prev = _registerValues.get(fk);
      _registerValues.set(fk, {
        bytes: f.bytes,
        decoded: prev?.decoded ?? [],
        timestamp: f.timestamp_us,
        pollIntervalMs: frameDef.interval,
      });
      changed = true;
    }

    if (changed) {
      set({ registerVersion: get().registerVersion + 1 });
    }
  },

  // Apply decoded signals from the Rust decoder stream, merging onto whatever
  // raw bytes are already stored for each register.
  applyDecoded: (decoded: DecodedFrameMsg[]) => {
    const { frames } = get();
    if (frames.size === 0) return;

    let changed = false;

    for (const msg of decoded) {
      const fk = frameKey('modbus', msg.frameId);
      const frameDef = frames.get(fk);
      if (!frameDef) continue;

      const values: DecodedSignalValue[] = msg.signals.map((s) => ({
        name: s.name,
        value: s.display,
        unit: s.unit ?? undefined,
        rawValue: s.value,
      }));

      const prev = _registerValues.get(fk);
      _registerValues.set(fk, {
        bytes: prev?.bytes ?? [],
        decoded: values,
        timestamp: msg.t,
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
