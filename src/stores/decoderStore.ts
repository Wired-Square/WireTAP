// ui/src/stores/decoderStore.ts

import { create } from 'zustand';
import { tlog } from '../api/settings';
import { LRUMap } from '../utils/LRUMap';
import {
  useSettingsStore,
  DEFAULT_DECODER_MAX_DECODED_FRAMES,
  DEFAULT_DECODER_MAX_DECODED_PER_SOURCE,
} from '../apps/settings/stores/settingsStore';

/** Maximum number of unique values to track per header field */
const MAX_HEADER_FIELD_VALUES = 256;

/** Read current decoder buffer limits from the settings store. */
function getDecoderLimits() {
  const { buffers } = useSettingsStore.getState();
  return {
    maxUnmatched: buffers.decoderMaxUnmatchedFrames,
    maxFiltered: buffers.decoderMaxFilteredFrames,
    maxDecoded: buffers.decoderMaxDecodedFrames,
    maxDecodedPerSource: buffers.decoderMaxDecodedPerSource,
  };
}

// Mutable decoded state — avoids creating new LRUMap/Array copies on every
// 100ms decode flush, which causes JSC GC pressure that crashes the WebView
// after ~2 hours of streaming. Components subscribe to `decodedVersion` for
// reactivity and read from these via getter functions.
let _decoded: LRUMap<number, DecodedFrame> = new LRUMap(DEFAULT_DECODER_MAX_DECODED_FRAMES);
let _decodedPerSource: LRUMap<string, DecodedFrame> = new LRUMap(DEFAULT_DECODER_MAX_DECODED_PER_SOURCE);
let _unmatchedFrames: UnmatchedFrame[] = [];
let _filteredFrames: FilteredFrame[] = [];

/** Direct access to the mutable decoded LRU map. Read-only. */
export function getDecodedFrames(): LRUMap<number, DecodedFrame> { return _decoded; }
/** Direct access to the mutable per-source decoded LRU map. Read-only. */
export function getDecodedPerSource(): LRUMap<string, DecodedFrame> { return _decodedPerSource; }
/** Direct access to the mutable unmatched frames array. Read-only. */
export function getUnmatchedFrames(): UnmatchedFrame[] { return _unmatchedFrames; }
/** Direct access to the mutable filtered frames array. Read-only. */
export function getFilteredFrames(): FilteredFrame[] { return _filteredFrames; }

import { saveCatalog } from '../api';
import { buildFramesToml, type SerialFrameConfig } from '../utils/frameExport';
import { formatFrameId } from '../utils/frameIds';
import type { FrameDetail, SignalDef } from '../types/decoder';
import type { DecodedFrameMsg } from '../services/wsProtocol';
import type { SelectionSet } from '../utils/selectionSets';
import type { CanHeaderField, HeaderFieldFormat } from '../apps/catalog/types';
import type { PlaybackSpeed } from '../components/TimeController';
import { loadCatalog as loadCatalogFromPath, attachAndResolve, parseCanId, type ParsedCatalog, type ModbusProtocolConfig } from '../utils/catalogParser';
import { buildPollsFromCatalog, type ModbusPollGroup } from '../utils/modbusPollBuilder';
import { frameKey } from '../utils/frameKey';


// Re-export for consumers that import from decoderStore
export type { PlaybackSpeed } from '../components/TimeController';


export type DecodedSignal = {
  name: string;
  value: string;
  unit?: string;
  format?: string;
  rawValue?: number;
  /** Mux selector value this signal belongs to (undefined for non-mux signals) */
  muxValue?: number;
  /** Timestamp when this signal was last updated (epoch seconds) */
  timestamp?: number;
};

/** Extracted header field value with display formatting */
export type HeaderFieldValue = {
  name: string;
  value: number;
  display: string;
  format: HeaderFieldFormat;
};

/** Mux selector value with its definition info */
export type MuxSelectorValue = {
  /** Name of the mux (if defined) */
  name?: string;
  /** The current selector value read from the frame */
  value: number;
  /** The case key that matched (e.g., "0", "0-3", "1,2,5") */
  matchedCase?: string;
  /** Bit position of the selector */
  startBit: number;
  /** Bit length of the selector */
  bitLength: number;
};

export type DecodedFrame = {
  signals: DecodedSignal[];
  rawBytes: number[];
  /** Extracted header field values from frame ID (CAN) or frame bytes (Serial) */
  headerFields: HeaderFieldValue[];
  /** Source address extracted from frame (for per-source view mode) */
  sourceAddress?: number;
  /** Mux selector values (one per mux level, supports nested muxes) */
  muxSelectors?: MuxSelectorValue[];
};

export type FrameMetadata = {
  name: string;
  version: number;
  default_byte_order: 'little' | 'big';
  default_interval: number;
  filename: string;
};

/** CAN config from [frame.can.config] - used for frame ID masking and header field extraction */
export type CanConfig = {
  default_byte_order?: 'little' | 'big';
  default_interval?: number;
  /** Mask applied to frame_id before catalog matching (e.g., 0x1FFFFF00 for J1939) */
  frame_id_mask?: number;
  /** Header fields extracted from CAN ID (e.g., source_address, priority, pgn) */
  fields?: Record<string, CanHeaderField>;
};


/** View mode for decoded frames: single (most recent) or per-source (by source address) */
export type DecoderViewMode = 'single' | 'per-source';

/** Unmatched frame that doesn't match any frame ID in the catalog */
export type UnmatchedFrame = {
  frameId: number;
  bytes: number[];
  timestamp: number;
  sourceAddress?: number;
};

/** Filtered frame (too short or matched by ID filter) */
export type FilteredFrame = {
  frameId: number;
  bytes: number[];
  timestamp: number;
  sourceAddress?: number;
  reason: 'too_short' | 'id_filter';
};

/** Mirror validation entry - tracks comparison between mirror and source frames */
export type MirrorValidationEntry = {
  sourceFrameId: number;
  mirrorFrameId: number;
  lastMirrorBytes: number[];
  lastMirrorTimestamp: number;
  lastSourceBytes: number[];
  lastSourceTimestamp: number;
  /** true = match, false = mismatch, null = unknown/waiting */
  isValid: boolean | null;
  /** Time delta between mirror and source frame arrival (ms) */
  timeDeltaMs: number;
  /** Byte indices to compare (inherited signal bytes) */
  inheritedByteIndices: Set<number>;
  /** Byte indices that don't match between mirror and source (for per-signal display) */
  mismatchedByteIndices: Set<number>;
  /** Consecutive mismatch count for hysteresis (only flip to Mismatch after several bad validations) */
  consecutiveMismatches: number;
};

interface DecoderState {
  // Catalog and frames (Map/Set keys are composite frame keys, e.g. "can:256")
  catalogPath: string | null;
  frames: Map<string, FrameDetail>;
  selectedFrames: Set<string>;
  seenIds: Set<string>;
  /** Protocol type from catalog meta (default_frame) */
  protocol: 'can' | 'serial' | 'modbus';
  /** CAN config from [frame.can.config] - used for frame ID masking and source address extraction */
  canConfig: CanConfig | null;
  /** Serial config from [frame.serial.config] - used for frame ID/source address extraction */
  serialConfig: SerialFrameConfig | null;
  /** Map of mirror frame ID to source frame ID for mirror validation */
  mirrorSourceMap: Map<number, number>;
  /** Mirror validation results - keyed by mirror frame ID */
  mirrorValidation: Map<number, MirrorValidationEntry>;
  /** Fuzz window for mirror validation (ms) - frames must arrive within this window to compare */
  mirrorFuzzWindowMs: number;

  // Modbus polling config — populated only when the catalog protocol is 'modbus'.
  // The register data itself flows through the normal decode pipeline (_decoded);
  // these drive poll-group injection into watchSource and the register adornments.
  /** Poll groups derived from the Modbus catalog (empty for non-modbus). */
  pollGroups: ModbusPollGroup[];
  /** JSON-serialised poll groups for watchSource; null when no modbus polls. */
  modbusPollsJson: string | null;
  /** Modbus protocol meta from the catalog (null for non-modbus). */
  modbusConfig: ModbusProtocolConfig | null;

  // Decoding state (actual data lives in module-level mutables — see getters above)
  /** Version counter for decoded data — bumped on every decode batch.
   *  Components subscribe to this for reactivity and read data via getter functions. */
  decodedVersion: number;
  ioProfile: string | null;
  showRawBytes: boolean;
  /** View mode: 'single' shows most recent per frame, 'per-source' shows by source address */
  viewMode: DecoderViewMode;
  /** Hide frames that haven't been seen (decoded) yet */
  hideUnseen: boolean;
  /** Header field filters - map of field name to set of selected values (empty = show all) */
  headerFieldFilters: Map<string, Set<number>>;
  /** Accumulated header field values seen - map of field name to map of value to {display, count} */
  seenHeaderFieldValues: Map<string, Map<number, { display: string; count: number }>>;
  /** Show ASCII gutter in unmatched/filtered tabs */
  showAsciiGutter: boolean;
  /** Frame ID filter for unmatched/filtered tabs (hex string, e.g., "0x1F3" or just "1F3") */
  frameIdFilter: string;
  /** Parsed frame ID filter as a Set of IDs (null = no filter) */
  frameIdFilterSet: Set<number> | null;

  /** Stream start time in epoch seconds (captured from first decoded signal) */
  streamStartTimeSeconds: number | null;

  // Playback control (for PostgreSQL profiles)
  playbackSpeed: PlaybackSpeed;
  currentTime: number | null;
  currentFrameIndex: number | null;

  // Time range (for PostgreSQL profiles)
  startTime: string;
  endTime: string;

  // Save dialog
  showSaveDialog: boolean;
  saveMetadata: FrameMetadata;

  // Selection set state
  activeSelectionSetId: string | null;
  selectionSetDirty: boolean;

  // UI state (session-only, not persisted)
  /** Scroll positions per tab (signals, unmatched, filtered) */
  scrollPositions: Record<string, number>;

  // Actions - Catalog
  /** Parse-only load (no session bind). Use for Query / before a session exists. */
  loadCatalog: (path: string) => Promise<void>;
  /** Attach to a session for Rust decode AND load the model from that one parse. */
  loadCatalogForSession: (sessionId: string, path: string) => Promise<void>;
  /** Build the in-memory model from an already-resolved catalogue. */
  applyParsedCatalog: (catalog: ParsedCatalog, path: string) => void;
  /** Track the active catalogue path without parsing (mirrors session changes). */
  setCatalogPath: (path: string | null) => void;
  initFromSettings: (decoderDir?: string, defaultReadProfile?: string | null) => Promise<void>;

  // Actions - Frame management
  toggleFrameSelection: (id: string) => void;
  bulkSelectBus: (bus: number | null, select: boolean) => void;
  selectAllFrames: () => void;
  deselectAllFrames: () => void;
  clearFrames: () => void;
  clearDecoded: () => void;

  // Actions - Decoding
  /** Batch decode multiple frames in a single state update (for high-speed playback) */
  decodeSignalsBatch: (
    framesToDecode: Array<{ frameId: number; bytes: number[]; sourceAddress?: number; timestamp?: number }>,
    unmatchedFrames: UnmatchedFrame[],
    filteredFrames: FilteredFrame[]
  ) => void;
  applyDecodedBatch: (decoded: DecodedFrameMsg[]) => void;
  addUnmatchedFrame: (frame: UnmatchedFrame) => void;
  clearUnmatchedFrames: () => void;
  addFilteredFrame: (frame: FilteredFrame) => void;
  clearFilteredFrames: () => void;
  setIoProfile: (profile: string | null) => void;
  toggleShowRawBytes: () => void;
  toggleHideUnseen: () => void;
  setViewMode: (mode: DecoderViewMode) => void;
  toggleViewMode: () => void;
  setMinFrameLength: (length: number) => void;
  toggleAsciiGutter: () => void;
  setFrameIdFilter: (filter: string) => void;

  // Actions - Header field filters
  toggleHeaderFieldFilter: (fieldName: string, value: number) => void;
  clearHeaderFieldFilter: (fieldName: string) => void;
  clearAllHeaderFieldFilters: () => void;

  // Actions - Playback control
  setPlaybackSpeed: (speed: PlaybackSpeed) => void;
  updateCurrentTime: (time: number) => void;
  setCurrentFrameIndex: (index: number) => void;

  // Actions - Time range
  setStartTime: (time: string) => void;
  setEndTime: (time: string) => void;

  // Actions - Save dialog
  openSaveDialog: () => void;
  closeSaveDialog: () => void;
  updateSaveMetadata: (metadata: FrameMetadata) => void;
  saveFrames: (decoderDir: string, saveFrameIdFormat: 'hex' | 'decimal') => Promise<void>;

  // Actions - Selection sets
  setActiveSelectionSet: (id: string | null) => void;
  setSelectionSetDirty: (dirty: boolean) => void;
  applySelectionSet: (selectionSet: SelectionSet) => void;

  // Actions - Scroll position
  setScrollPosition: (tabId: string, position: number) => void;
}

export const useDecoderStore = create<DecoderState>((set, get) => ({
  // Initial state
  catalogPath: null,
  frames: new Map(),
  selectedFrames: new Set(),
  seenIds: new Set(),
  protocol: 'can',
  canConfig: null,
  serialConfig: null,
  mirrorSourceMap: new Map(),
  mirrorValidation: new Map(),
  mirrorFuzzWindowMs: 1000, // 1 second - generous to handle batching and varying frame rates
  pollGroups: [],
  modbusPollsJson: null,
  modbusConfig: null,
  decodedVersion: 0,
  ioProfile: null,
  showRawBytes: false,
  viewMode: 'single',
  hideUnseen: true,
  headerFieldFilters: new Map(),
  seenHeaderFieldValues: new Map(),
  showAsciiGutter: false,
  frameIdFilter: '',
  frameIdFilterSet: null,
  streamStartTimeSeconds: null,
  scrollPositions: {},
  playbackSpeed: 1,
  currentTime: null,
  currentFrameIndex: null,
  startTime: '',
  endTime: '',
  showSaveDialog: false,
  saveMetadata: {
    name: 'Discovered Frames',
    version: 1,
    default_byte_order: 'little',
    default_interval: 1000,
    filename: 'discovered-frames.toml',
  },
  activeSelectionSetId: null,
  selectionSetDirty: false,

  // Catalog actions
  loadCatalog: async (path: string) => {
    get().applyParsedCatalog(await loadCatalogFromPath(path), path);
  },

  loadCatalogForSession: async (sessionId: string, path: string) => {
    try {
      // catalog.attach binds Rust decode AND returns the resolved catalogue, so
      // the model comes from the same parse.
      get().applyParsedCatalog(await attachAndResolve(sessionId, path), path);
    } catch (e) {
      // If attach fails, still load the model so the UI works without decode.
      tlog.info(`[decoderStore] catalog attach failed, loading model only: ${e}`);
      await get().loadCatalog(path);
    }
  },

  setCatalogPath: (path: string | null) => set({ catalogPath: path }),

  applyParsedCatalog: (catalog: ParsedCatalog, path: string) => {
    try {
      // Convert ParsedCatalog to decoder's FrameDetail format
      // Use composite keys (e.g. "can:256", "modbus:5013")
      const proto = catalog.protocol;
      const frameMap = new Map<string, FrameDetail>();
      const seenIds = new Set<string>();

      for (const [id, frame] of catalog.frames) {
        const fk = frameKey(proto, id);
        frameMap.set(fk, {
          id,
          len: frame.length,
          isExtended: frame.isExtended,
          bus: frame.bus,
          lenMismatch: false,
          signals: frame.signals as SignalDef[],
          mux: frame.mux,
          interval: frame.interval,
          modbusRegisterType: frame.modbusRegisterType,
          mirrorOf: frame.mirrorOf,
          copyFrom: frame.copyFrom,
        });
        seenIds.add(fk);
      }

      // Convert CanProtocolConfig to CanConfig (compatible structure)
      let canConfig: CanConfig | null = null;
      if (catalog.canConfig) {
        const fields: Record<string, CanHeaderField> | undefined = catalog.canConfig.fields
          ? Object.fromEntries(
              Object.entries(catalog.canConfig.fields).map(([name, field]) => [
                name,
                {
                  mask: field.mask,
                  shift: field.shift,
                  format: field.format || 'hex',
                } as CanHeaderField,
              ])
            )
          : undefined;

        canConfig = {
          default_byte_order: catalog.canConfig.default_byte_order,
          default_interval: catalog.canConfig.default_interval,
          frame_id_mask: catalog.canConfig.frame_id_mask,
          fields,
        };
      }

      // Convert SerialProtocolConfig to SerialFrameConfig
      let serialConfig: SerialFrameConfig | null = null;
      if (catalog.serialConfig) {
        const sc = catalog.serialConfig;
        serialConfig = {
          default_byte_order: sc.default_byte_order,
          encoding: sc.encoding,
          frame_id_start_byte: sc.frame_id_start_byte,
          frame_id_bytes: sc.frame_id_bytes,
          frame_id_byte_order: sc.frame_id_byte_order,
          frame_id_mask: sc.frame_id_mask,
          source_address_start_byte: sc.source_address_start_byte,
          source_address_bytes: sc.source_address_bytes,
          source_address_byte_order: sc.source_address_byte_order,
          min_frame_length: sc.min_frame_length,
          header_length: sc.header_length,
          header_fields: sc.header_fields,
          checksum: sc.checksum ? {
            algorithm: sc.checksum.algorithm,
            start_byte: sc.checksum.start_byte,
            byte_length: sc.checksum.byte_length,
            calc_start_byte: sc.checksum.calc_start_byte,
            calc_end_byte: sc.checksum.calc_end_byte ?? -1,
            big_endian: sc.checksum.big_endian ?? false,
          } : undefined,
        };
      }

      // Preserve existing frame selection when reloading catalog
      const { selectedFrames: currentSelected, catalogPath: currentPath } = get();
      const isReload = currentPath === path;

      let newSelected: Set<string>;
      if (isReload && currentSelected.size > 0) {
        // Reloading same catalog: preserve selection, add new frames as selected
        const existingFrameKeys = new Set(frameMap.keys());
        newSelected = new Set<string>();

        for (const fk of currentSelected) {
          if (existingFrameKeys.has(fk)) {
            newSelected.add(fk);
          }
        }

        for (const fk of existingFrameKeys) {
          if (!currentSelected.has(fk) && !get().frames.has(fk)) {
            newSelected.add(fk);
          }
        }
      } else {
        newSelected = new Set(Array.from(frameMap.keys()));
      }

      // Build mirror source map for validation
      const mirrorSourceMap = new Map<number, number>();
      for (const [id, frame] of catalog.frames) {
        if (frame.mirrorOf) {
          const sourceId = parseCanId(frame.mirrorOf);
          if (sourceId !== null) {
            mirrorSourceMap.set(id, sourceId);
          }
        }
      }

      // Apply Modbus default_word_order to signals that don't have an explicit word_order
      if (catalog.modbusConfig?.default_word_order) {
        const defaultWo = catalog.modbusConfig.default_word_order;
        for (const [, frame] of frameMap) {
          for (const signal of frame.signals) {
            if (!signal.word_order) signal.word_order = defaultWo;
          }
          if (frame.mux) {
            for (const caseDef of Object.values(frame.mux.cases)) {
              for (const signal of caseDef.signals) {
                if (!signal.word_order) signal.word_order = defaultWo;
              }
            }
          }
        }
      }

      // Build Modbus poll groups (empty for non-modbus catalogues). Done here so
      // the poll config is computed in the same parse transaction that sets
      // frames/protocol — it can never drift, and switching to a non-modbus
      // catalogue clears stale modbus state.
      const pollGroups = catalog.protocol === 'modbus'
        ? buildPollsFromCatalog(catalog.frames, catalog.modbusConfig)
        : [];
      const modbusPollsJson = pollGroups.length > 0 ? JSON.stringify(pollGroups) : null;

      set({
        frames: frameMap,
        selectedFrames: newSelected,
        catalogPath: path,
        seenIds,
        protocol: catalog.protocol,
        canConfig,
        serialConfig,
        mirrorSourceMap,
        pollGroups,
        modbusPollsJson,
        modbusConfig: catalog.modbusConfig,
      });
    } catch (e) {
      tlog.info(`[decoderStore] Failed to load catalog: ${e}`);
      throw e;
    }
  },

  initFromSettings: async (_decoderDir, defaultReadProfile) => {
    if (defaultReadProfile) {
      set({ ioProfile: defaultReadProfile });
    }
    // decoderDir is stored implicitly via the catalog path when a catalog is loaded
  },

  // Frame management actions
  toggleFrameSelection: (id) => {
    const { selectedFrames, activeSelectionSetId } = get();
    const next = new Set(selectedFrames);
    if (next.has(id)) {
      next.delete(id);
    } else {
      next.add(id);
    }
    set({
      selectedFrames: next,
      selectionSetDirty: activeSelectionSetId !== null,
    });
  },

  bulkSelectBus: (bus, select) => {
    const { frames, selectedFrames, activeSelectionSetId } = get();
    const keys = Array.from(frames.entries())
      .filter(([, f]) => bus === null ? f.bus === undefined : f.bus === bus)
      .map(([fk]) => fk);

    if (keys.length === 0) return;

    const next = new Set(selectedFrames);
    keys.forEach((fk) => {
      if (select) {
        next.add(fk);
      } else {
        next.delete(fk);
      }
    });
    set({
      selectedFrames: next,
      selectionSetDirty: activeSelectionSetId !== null,
    });
  },

  selectAllFrames: () => {
    const { frames, activeSelectionSetId } = get();
    set({
      selectedFrames: new Set(Array.from(frames.keys())),
      selectionSetDirty: activeSelectionSetId !== null,
    });
  },

  deselectAllFrames: () => {
    const { activeSelectionSetId } = get();
    set({
      selectedFrames: new Set(),
      selectionSetDirty: activeSelectionSetId !== null,
    });
  },

  clearFrames: () => {
    // Only clear session/buffer data, NOT the catalog frames
    const limits = getDecoderLimits();
    _decoded = new LRUMap(limits.maxDecoded);
    _decodedPerSource = new LRUMap(limits.maxDecodedPerSource);
    _unmatchedFrames = [];
    _filteredFrames = [];
    set({
      seenIds: new Set(),
      decodedVersion: get().decodedVersion + 1,
      seenHeaderFieldValues: new Map(),
      headerFieldFilters: new Map(),
      streamStartTimeSeconds: null,
    });
  },

  clearDecoded: () => {
    const limits = getDecoderLimits();
    _decoded = new LRUMap(limits.maxDecoded);
    _decodedPerSource = new LRUMap(limits.maxDecodedPerSource);
    _unmatchedFrames = [];
    _filteredFrames = [];
    set({
      decodedVersion: get().decodedVersion + 1,
      seenHeaderFieldValues: new Map(),
      headerFieldFilters: new Map(),
      streamStartTimeSeconds: null,
    });
  },

  // Store raw frame bytes + run mirror validation. Signal decoding moved to
  // Rust: decoded values arrive via applyDecodedBatch (the DecodedSignals
  // stream). This keeps the raw byte view and the mirror-validation byte
  // compare (which needs the raw bytes + frame timing) on the frame path.
  decodeSignalsBatch: (framesToDecode, unmatchedToAdd, filteredToAdd) => {
    if (framesToDecode.length === 0 && unmatchedToAdd.length === 0 && filteredToAdd.length === 0) {
      return;
    }

    const { frames, protocol, canConfig, serialConfig, mirrorSourceMap, mirrorValidation, mirrorFuzzWindowMs } = get();

    const nextDecoded = _decoded;
    const nextMirrorValidation = new Map(mirrorValidation);

    // Pre-build reverse mirror map: sourceId → mirrorIds[]
    const reverseMirrorMap = new Map<number, number[]>();
    for (const [mirrorId, sourceId] of mirrorSourceMap) {
      const existing = reverseMirrorMap.get(sourceId);
      if (existing) {
        existing.push(mirrorId);
      } else {
        reverseMirrorMap.set(sourceId, [mirrorId]);
      }
    }

    const now = Date.now() / 1000;

    for (const { frameId, bytes, timestamp } of framesToDecode) {
      // Apply frame_id_mask before catalog lookup (header fields + signal decode
      // now come from the Rust stream).
      let maskedFrameId = frameId;
      if (protocol === 'can' && canConfig?.frame_id_mask !== undefined) {
        maskedFrameId = frameId & canConfig.frame_id_mask;
      } else if (protocol === 'serial' && serialConfig?.frame_id_mask !== undefined) {
        maskedFrameId = frameId & serialConfig.frame_id_mask;
      }

      const frame = frames.get(frameKey(protocol, maskedFrameId));
      if (!frame) continue;

      // Store raw bytes, preserving any decoded values already received.
      const existing = nextDecoded.get(maskedFrameId);
      nextDecoded.set(maskedFrameId, existing
        ? { ...existing, rawBytes: bytes }
        : { signals: [], rawBytes: bytes, headerFields: [], sourceAddress: undefined, muxSelectors: undefined });

      // Mirror validation: compare bytes between mirror and source frames
      const mirrorSourceId = mirrorSourceMap.get(maskedFrameId);
      const mirrorsOfThisSource = reverseMirrorMap.get(maskedFrameId) ?? [];

      if (mirrorSourceId !== undefined || mirrorsOfThisSource.length > 0) {
        const updateValidationEntry = (validationKey: number, sourceFrameId: number, mirrorFrameId: number, isMirrorFrame: boolean) => {
          const sourceFrame = frames.get(frameKey(protocol, sourceFrameId));
          const frameInterval = sourceFrame?.interval ?? canConfig?.default_interval ?? mirrorFuzzWindowMs;
          const effectiveFuzzWindow = frameInterval * 2;

          let entry = nextMirrorValidation.get(validationKey);
          if (!entry) {
            const mirrorFrame = frames.get(frameKey(protocol, mirrorFrameId));
            const inheritedByteIndices = new Set<number>();
            if (mirrorFrame) {
              for (const signal of mirrorFrame.signals) {
                if (signal._inherited && signal.start_bit !== undefined && signal.bit_length !== undefined) {
                  const startByte = Math.floor(signal.start_bit / 8);
                  const endByte = Math.floor((signal.start_bit + signal.bit_length - 1) / 8);
                  for (let i = startByte; i <= endByte; i++) {
                    inheritedByteIndices.add(i);
                  }
                }
              }
            }
            entry = {
              sourceFrameId, mirrorFrameId,
              lastMirrorBytes: [], lastMirrorTimestamp: 0,
              lastSourceBytes: [], lastSourceTimestamp: 0,
              isValid: null, timeDeltaMs: 0,
              inheritedByteIndices,
              mismatchedByteIndices: new Set(),
              consecutiveMismatches: 0,
            };
          }

          const validationTimestamp = timestamp ?? now;
          if (isMirrorFrame) {
            entry.lastMirrorBytes = [...bytes];
            entry.lastMirrorTimestamp = validationTimestamp;
          } else {
            entry.lastSourceBytes = [...bytes];
            entry.lastSourceTimestamp = validationTimestamp;
          }

          const timeDelta = Math.abs(entry.lastMirrorTimestamp - entry.lastSourceTimestamp) * 1000;
          entry.timeDeltaMs = timeDelta;

          if (entry.lastMirrorBytes.length > 0 && entry.lastSourceBytes.length > 0) {
            if (timeDelta <= effectiveFuzzWindow) {
              const mismatched = new Set<number>();
              for (const idx of entry.inheritedByteIndices) {
                if (entry.lastMirrorBytes[idx] !== entry.lastSourceBytes[idx]) {
                  mismatched.add(idx);
                }
              }
              entry.mismatchedByteIndices = mismatched;

              if (mismatched.size === 0) {
                entry.consecutiveMismatches = 0;
                entry.isValid = true;
              } else {
                entry.consecutiveMismatches++;
                if (entry.consecutiveMismatches >= 3) {
                  entry.isValid = false;
                }
              }
            }
          }

          nextMirrorValidation.set(validationKey, entry);
        };

        if (mirrorSourceId !== undefined) {
          updateValidationEntry(maskedFrameId, mirrorSourceId, maskedFrameId, true);
        }
        for (const mirrorId of mirrorsOfThisSource) {
          updateValidationEntry(mirrorId, maskedFrameId, mirrorId, false);
        }
      }
    }

    // Add unmatched frames in place (with limit)
    const limits = getDecoderLimits();
    if (unmatchedToAdd.length > 0) {
      _unmatchedFrames.push(...unmatchedToAdd);
      if (_unmatchedFrames.length > limits.maxUnmatched) {
        _unmatchedFrames = _unmatchedFrames.slice(-limits.maxUnmatched);
      }
    }

    // Add filtered frames in place (with limit)
    if (filteredToAdd.length > 0) {
      _filteredFrames.push(...filteredToAdd);
      if (_filteredFrames.length > limits.maxFiltered) {
        _filteredFrames = _filteredFrames.slice(-limits.maxFiltered);
      }
    }

    set({
      decodedVersion: get().decodedVersion + 1,
      mirrorValidation: nextMirrorValidation,
    });
  },

  // Apply decoded signals from the Rust DecodedSignals stream — signals (merged
  // by muxValue:name so each mux case persists), header fields, source address,
  // and mux selectors. Raw bytes come from decodeSignalsBatch (the frame path);
  // the two merge into the same _decoded entry.
  applyDecodedBatch: (decoded: DecodedFrameMsg[]) => {
    if (decoded.length === 0) return;

    const { protocol, canConfig, serialConfig, seenHeaderFieldValues, streamStartTimeSeconds } = get();
    const nextDecoded = _decoded;
    const nextDecodedPerSource = _decodedPerSource;
    const nextSeenValues = new Map(seenHeaderFieldValues);
    let newStreamStartTime = streamStartTimeSeconds;
    const now = Date.now() / 1000;
    if (newStreamStartTime === null) newStreamStartTime = now;

    const signalKey = (signal: DecodedSignal) =>
      signal.muxValue !== undefined ? `${signal.muxValue}:${signal.name}` : signal.name;

    for (const msg of decoded) {
      let maskedFrameId = msg.frameId;
      if (protocol === 'can' && canConfig?.frame_id_mask !== undefined) {
        maskedFrameId = msg.frameId & canConfig.frame_id_mask;
      } else if (protocol === 'serial' && serialConfig?.frame_id_mask !== undefined) {
        maskedFrameId = msg.frameId & serialConfig.frame_id_mask;
      }

      const headerFields: HeaderFieldValue[] = msg.headerFields.map((h) => ({
        name: h.name,
        value: h.value,
        display: h.display,
        format: (h.format === 'decimal' ? 'decimal' : 'hex'),
      }));
      const sourceAddress = msg.sourceAddress ?? undefined;
      const muxSelectors: MuxSelectorValue[] = msg.selectors.map((s) => ({
        name: s.name ?? undefined,
        value: s.value,
        matchedCase: s.matchedCase ?? undefined,
        startBit: s.startBit,
        bitLength: s.bitLength,
      }));

      // Merge new signals over previously-seen ones (preserves inactive mux cases).
      const existing = nextDecoded.get(maskedFrameId);
      const mergedSignals = new Map<string, DecodedSignal>();
      for (const signal of existing?.signals ?? []) {
        mergedSignals.set(signalKey(signal), signal);
      }
      for (const s of msg.signals) {
        const sig: DecodedSignal = {
          name: s.name,
          value: s.display,
          unit: s.unit ?? undefined,
          format: s.format ?? undefined,
          rawValue: s.value,
          muxValue: s.muxValue ?? undefined,
          timestamp: now,
        };
        mergedSignals.set(signalKey(sig), sig);
      }

      const decodedFrame: DecodedFrame = {
        signals: Array.from(mergedSignals.values()),
        rawBytes: existing?.rawBytes ?? [],
        headerFields,
        sourceAddress,
        muxSelectors: muxSelectors.length > 0 ? muxSelectors : undefined,
      };
      nextDecoded.set(maskedFrameId, decodedFrame);

      if (sourceAddress !== undefined) {
        nextDecodedPerSource.set(`${maskedFrameId}:${sourceAddress}`, decodedFrame);
      }

      // Accumulate header field values for the filter UI.
      for (const field of headerFields) {
        let fieldMap = nextSeenValues.get(field.name);
        if (!fieldMap) {
          fieldMap = new Map();
          nextSeenValues.set(field.name, fieldMap);
        }
        const seen = fieldMap.get(field.value);
        if (seen) {
          seen.count++;
        } else if (fieldMap.size < MAX_HEADER_FIELD_VALUES) {
          fieldMap.set(field.value, { display: field.display, count: 1 });
        }
      }
    }

    set({
      decodedVersion: get().decodedVersion + 1,
      seenHeaderFieldValues: nextSeenValues,
      streamStartTimeSeconds: newStreamStartTime,
    });
  },

  addUnmatchedFrame: (frame) => {
    _unmatchedFrames.push(frame);
    const maxUnmatched = getDecoderLimits().maxUnmatched;
    if (_unmatchedFrames.length > maxUnmatched) {
      _unmatchedFrames.splice(0, _unmatchedFrames.length - maxUnmatched);
    }
    set({ decodedVersion: get().decodedVersion + 1 });
  },

  clearUnmatchedFrames: () => {
    _unmatchedFrames = [];
    set({ decodedVersion: get().decodedVersion + 1 });
  },

  addFilteredFrame: (frame) => {
    _filteredFrames.push(frame);
    const maxFiltered = getDecoderLimits().maxFiltered;
    if (_filteredFrames.length > maxFiltered) {
      _filteredFrames.splice(0, _filteredFrames.length - maxFiltered);
    }
    set({ decodedVersion: get().decodedVersion + 1 });
  },

  clearFilteredFrames: () => {
    _filteredFrames = [];
    set({ decodedVersion: get().decodedVersion + 1 });
  },

  setIoProfile: (profile) => {
    const limits = getDecoderLimits();
    _decoded = new LRUMap(limits.maxDecoded);
    _decodedPerSource = new LRUMap(limits.maxDecodedPerSource);
    _unmatchedFrames = [];
    _filteredFrames = [];
    set({ ioProfile: profile, decodedVersion: get().decodedVersion + 1 });
  },

  toggleShowRawBytes: () => set((state) => ({ showRawBytes: !state.showRawBytes })),
  toggleHideUnseen: () => set((state) => ({ hideUnseen: !state.hideUnseen })),

  setViewMode: (mode) => set({ viewMode: mode }),

  toggleViewMode: () => set((state) => ({
    viewMode: state.viewMode === 'single' ? 'per-source' : 'single',
  })),

  setMinFrameLength: (length) => set((state) => ({
    serialConfig: state.serialConfig
      ? { ...state.serialConfig, min_frame_length: length }
      : { min_frame_length: length },
  })),

  toggleAsciiGutter: () => set((state) => ({
    showAsciiGutter: !state.showAsciiGutter,
    // Auto-enable showRawBytes when enabling ASCII gutter (since ASCII only shows with raw bytes)
    ...(state.showAsciiGutter ? {} : { showRawBytes: true }),
  })),
  setFrameIdFilter: (filter) => {
    // Parse the filter string into a Set of IDs
    // Supports: single ID (0x100), comma-separated (0x100, 0x151), ranges (0x100-0x109)
    let filterSet: Set<number> | null = null;

    if (filter.trim()) {
      const ids = new Set<number>();
      const parts = filter.split(',').map(p => p.trim()).filter(p => p.length > 0);

      for (const part of parts) {
        // Check if it's a range (e.g., "0x100-0x109" or "100-109")
        const rangeMatch = part.match(/^(0x)?([0-9a-fA-F]+)\s*-\s*(0x)?([0-9a-fA-F]+)$/);
        if (rangeMatch) {
          const start = parseInt(rangeMatch[2], 16);
          const end = parseInt(rangeMatch[4], 16);
          if (!isNaN(start) && !isNaN(end)) {
            const min = Math.min(start, end);
            const max = Math.max(start, end);
            // Limit range to prevent excessive memory usage
            const rangeSize = max - min + 1;
            if (rangeSize <= 1000) {
              for (let i = min; i <= max; i++) {
                ids.add(i);
              }
            }
          }
        } else {
          // Single ID
          const cleaned = part.toLowerCase().replace(/^0x/, '');
          const parsed = parseInt(cleaned, 16);
          if (!isNaN(parsed)) {
            ids.add(parsed);
          }
        }
      }

      if (ids.size > 0) {
        filterSet = ids;
      }
    }

    set({ frameIdFilter: filter, frameIdFilterSet: filterSet });
  },

  // Header field filter actions
  toggleHeaderFieldFilter: (fieldName, value) => set((state) => {
    const next = new Map(state.headerFieldFilters);
    const current = next.get(fieldName) ?? new Set<number>();
    const updated = new Set(current);

    if (updated.has(value)) {
      updated.delete(value);
    } else {
      updated.add(value);
    }

    if (updated.size === 0) {
      next.delete(fieldName);
    } else {
      next.set(fieldName, updated);
    }

    return { headerFieldFilters: next };
  }),

  clearHeaderFieldFilter: (fieldName) => set((state) => {
    const next = new Map(state.headerFieldFilters);
    next.delete(fieldName);
    return { headerFieldFilters: next };
  }),

  clearAllHeaderFieldFilters: () => set({ headerFieldFilters: new Map() }),

  // Playback control actions
  setPlaybackSpeed: (speed) => {
    set({ playbackSpeed: speed });
  },

  updateCurrentTime: (time) => set({ currentTime: time }),
  setCurrentFrameIndex: (index) => set({ currentFrameIndex: index }),

  // Time range actions
  setStartTime: (time) => set({ startTime: time }),
  setEndTime: (time) => set({ endTime: time }),

  // Save dialog actions
  openSaveDialog: () => set({ showSaveDialog: true }),

  closeSaveDialog: () => set({ showSaveDialog: false }),

  updateSaveMetadata: (metadata) => set({ saveMetadata: metadata }),

  saveFrames: async (decoderDir, saveFrameIdFormat) => {
    const { selectedFrames, frames, saveMetadata } = get();

    if (!decoderDir) {
      tlog.info("[decoderStore] Decoder directory is not set in settings");
      return;
    }

    const safeFilename = saveMetadata.filename.trim() || 'discovered-frames.toml';
    const filename = safeFilename.endsWith('.toml') ? safeFilename : `${safeFilename}.toml`;
    const baseDir = decoderDir.replace(/[\\/]+$/, '');
    const path = `${baseDir}/${filename}`;

    const selectedFramesList = Array.from(frames.entries())
      .filter(([fk]) => selectedFrames.has(fk))
      .map(([, f]) => f)
      .sort((a, b) => a.id - b.id);

    const content = buildFramesToml(
      selectedFramesList,
      {
        name: saveMetadata.name,
        version: Math.max(1, saveMetadata.version),
        default_byte_order: saveMetadata.default_byte_order,
        default_frame: 'can',
        default_interval: Math.max(0, saveMetadata.default_interval),
      },
      (id, isExt) => formatFrameId(id, saveFrameIdFormat, isExt)
    );

    await saveCatalog(path, content);
    set({ showSaveDialog: false });
  },

  // Selection set actions
  setActiveSelectionSet: (id) => set({ activeSelectionSetId: id }),

  setSelectionSetDirty: (dirty) => set({ selectionSetDirty: dirty }),

  applySelectionSet: (selectionSet) => {
    // Decoder behavior: only select IDs from selectedIds
    // (including IDs that don't exist in current catalog)
    // Fall back to frameIds for backwards compatibility with old selection sets
    // Convert numeric IDs to composite keys using the catalog's protocol
    const { protocol } = get();
    const idsToSelect = selectionSet.selectedIds ?? selectionSet.frameIds;
    const newSelectedFrames = new Set<string>();

    for (const numericId of idsToSelect) {
      newSelectedFrames.add(frameKey(protocol, numericId));
    }

    set({
      selectedFrames: newSelectedFrames,
      activeSelectionSetId: selectionSet.id,
      selectionSetDirty: false,
    });
  },

  setScrollPosition: (tabId, position) => {
    set({ scrollPositions: { ...get().scrollPositions, [tabId]: position } });
  },
}));
