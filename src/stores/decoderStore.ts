// ui/src/stores/decoderStore.ts

import { create } from 'zustand';
import { tlog } from '../api/settings';
import { LRUMap } from '../utils/LRUMap';

/** Maximum number of unmatched frames to keep in buffer */
export const MAX_UNMATCHED_FRAMES = 1000;
/** Maximum number of filtered frames to keep in buffer */
export const MAX_FILTERED_FRAMES = 1000;
/** Maximum number of decoded frames to keep (per frame ID) */
const MAX_DECODED_FRAMES = 500;
/** Maximum number of decoded frames to keep (per source address) */
const MAX_DECODED_PER_SOURCE = 2000;
/** Maximum number of unique values to track per header field */
const MAX_HEADER_FIELD_VALUES = 256;

// Mutable decoded state — avoids creating new LRUMap/Array copies on every
// 100ms decode flush, which causes JSC GC pressure that crashes the WebView
// after ~2 hours of streaming. Components subscribe to `decodedVersion` for
// reactivity and read from these via getter functions.
let _decoded: LRUMap<number, DecodedFrame> = new LRUMap(MAX_DECODED_FRAMES);
let _decodedPerSource: LRUMap<string, DecodedFrame> = new LRUMap(MAX_DECODED_PER_SOURCE);
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
import { decodeSignal } from '../utils/signalDecode';
import { extractBits } from '../utils/bits';
import type { FrameDetail, SignalDef, MuxDef } from '../types/decoder';
import { findMatchingMuxCase } from '../utils/muxCaseMatch';
import type { SelectionSet } from '../utils/selectionSets';
import type { CanHeaderField, HeaderFieldFormat } from '../apps/catalog/types';
import type { PlaybackSpeed } from '../components/TimeController';
import { loadCatalog as loadCatalogFromPath, parseCanId } from '../utils/catalogParser';
import { buildCatalogPath } from '../utils/catalogUtils';

// Re-export for consumers that import from decoderStore
export type { PlaybackSpeed } from '../components/TimeController';

/** Result of decoding a mux structure */
type MuxDecodeResult = {
  signals: { name: string; value: string; unit?: string; format?: string; rawValue?: number; muxValue?: number; timestamp?: number }[];
  selectors: MuxSelectorValue[];
};

/**
 * Decode signals from a mux structure based on the current frame bytes.
 * Reads the mux selector value and only decodes signals from the matching case.
 * Supports case keys as single values ("0"), ranges ("0-3"), or comma-separated ("1,2,5").
 * @param bytes - The frame payload bytes
 * @param mux - Mux definition with selector position and cases
 * @param defaultByteOrder - Catalog default byte order for signals without explicit byte_order
 * @param timestamp - Timestamp to assign to decoded signals (epoch seconds)
 */
function decodeMuxSignals(
  bytes: number[],
  mux: MuxDef,
  defaultByteOrder: 'little' | 'big' = 'little',
  timestamp?: number
): MuxDecodeResult {
  const signals: { name: string; value: string; unit?: string; format?: string; rawValue?: number; muxValue?: number; timestamp?: number }[] = [];
  const selectors: MuxSelectorValue[] = [];

  // Read the mux selector value (mux selector uses catalog default byte order)
  const selectorValue = extractBits(bytes, mux.start_bit, mux.bit_length, defaultByteOrder, false);

  // Find the matching case key (supports ranges like "0-3" and comma-separated like "1,2,5")
  const matchingCaseKey = findMatchingMuxCase(selectorValue, Object.keys(mux.cases));

  // Always record the selector value (even if no case matches)
  selectors.push({
    name: mux.name,
    value: selectorValue,
    matchedCase: matchingCaseKey,
    startBit: mux.start_bit,
    bitLength: mux.bit_length,
  });

  if (!matchingCaseKey) {
    // No matching case found
    return { signals, selectors };
  }

  const activeCase = mux.cases[matchingCaseKey];

  // Decode signals from the active case, passing default byte order
  for (const signal of activeCase.signals) {
    const decoded = decodeSignal(bytes, signal, signal.name || 'Signal', defaultByteOrder);
    signals.push({
      name: decoded.name,
      value: decoded.display,
      unit: decoded.unit,
      format: signal.format,
      rawValue: decoded.value,
      muxValue: selectorValue,
      timestamp,
    });
  }

  // Recursively decode nested mux if present
  if (activeCase.mux) {
    const nested = decodeMuxSignals(bytes, activeCase.mux, defaultByteOrder, timestamp);
    signals.push(...nested.signals);
    selectors.push(...nested.selectors);
  }

  return { signals, selectors };
}

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
  // Catalog and frames
  catalogPath: string | null;
  frames: Map<number, FrameDetail>;
  selectedFrames: Set<number>;
  seenIds: Set<number>;
  /** Protocol type from catalog meta (default_frame) */
  protocol: 'can' | 'serial';
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
  loadCatalog: (path: string) => Promise<void>;
  initFromSettings: (defaultCatalog?: string, decoderDir?: string, defaultReadProfile?: string | null) => Promise<void>;

  // Actions - Frame management
  toggleFrameSelection: (id: number) => void;
  bulkSelectBus: (bus: number | null, select: boolean) => void;
  selectAllFrames: () => void;
  deselectAllFrames: () => void;
  clearFrames: () => void;
  clearDecoded: () => void;

  // Actions - Decoding
  decodeSignals: (frameId: number, bytes: number[], sourceAddress?: number, frameTimestamp?: number) => void;
  /** Batch decode multiple frames in a single state update (for high-speed playback) */
  decodeSignalsBatch: (
    framesToDecode: Array<{ frameId: number; bytes: number[]; sourceAddress?: number; timestamp?: number }>,
    unmatchedFrames: UnmatchedFrame[],
    filteredFrames: FilteredFrame[]
  ) => void;
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
    try {
      // Use common catalog parser API
      const catalog = await loadCatalogFromPath(path);

      // Convert ParsedCatalog to decoder's FrameDetail format
      const frameMap = new Map<number, FrameDetail>();
      const seenIds = new Set<number>();

      for (const [id, frame] of catalog.frames) {
        frameMap.set(id, {
          id,
          len: frame.length,
          isExtended: frame.isExtended,
          bus: frame.bus,
          lenMismatch: false,
          signals: frame.signals as SignalDef[],
          mux: frame.mux,
          interval: frame.interval,
          mirrorOf: frame.mirrorOf,
          copyFrom: frame.copyFrom,
        });
        seenIds.add(id);
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

      let newSelected: Set<number>;
      if (isReload && currentSelected.size > 0) {
        // Reloading same catalog: preserve selection, add new frames as selected
        const existingFrameIds = new Set(frameMap.keys());
        newSelected = new Set<number>();

        for (const id of currentSelected) {
          if (existingFrameIds.has(id)) {
            newSelected.add(id);
          }
        }

        for (const id of existingFrameIds) {
          if (!currentSelected.has(id) && !get().frames.has(id)) {
            newSelected.add(id);
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

      set({
        frames: frameMap,
        selectedFrames: newSelected,
        catalogPath: path,
        seenIds,
        protocol: catalog.protocol,
        canConfig,
        serialConfig,
        mirrorSourceMap,
      });
    } catch (e) {
      tlog.info(`[decoderStore] Failed to load catalog: ${e}`);
    }
  },

  initFromSettings: async (defaultCatalog, decoderDir, defaultReadProfile) => {
    if (defaultReadProfile) {
      set({ ioProfile: defaultReadProfile });
    }

    if (defaultCatalog) {
      const path = buildCatalogPath(defaultCatalog, decoderDir);
      await get().loadCatalog(path);
    }
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
    const ids = Array.from(frames.values())
      .filter((f) => bus === null ? f.bus === undefined : f.bus === bus)
      .map((f) => f.id);

    if (ids.length === 0) return;

    const next = new Set(selectedFrames);
    ids.forEach((id) => {
      if (select) {
        next.add(id);
      } else {
        next.delete(id);
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
    _decoded = new LRUMap(MAX_DECODED_FRAMES);
    _decodedPerSource = new LRUMap(MAX_DECODED_PER_SOURCE);
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
    _decoded = new LRUMap(MAX_DECODED_FRAMES);
    _decodedPerSource = new LRUMap(MAX_DECODED_PER_SOURCE);
    _unmatchedFrames = [];
    _filteredFrames = [];
    set({
      decodedVersion: get().decodedVersion + 1,
      seenHeaderFieldValues: new Map(),
      headerFieldFilters: new Map(),
      streamStartTimeSeconds: null,
    });
  },

  // Decoding actions
  decodeSignals: (frameId, bytes, sourceAddress, frameTimestamp) => {
    const { frames, protocol, canConfig, serialConfig } = get();

    // Apply frame_id_mask before catalog lookup
    // This allows matching on message type only (e.g., J1939 PGN without source address)
    let maskedFrameId = frameId;

    // Extract header field values from frame ID (CAN) or bytes (Serial)
    const headerFields: HeaderFieldValue[] = [];

    // For CAN, extract source address from header fields if defined
    let effectiveSourceAddress = sourceAddress;

    if (protocol === 'can' && canConfig) {
      // Apply frame_id_mask to CAN ID before matching
      if (canConfig.frame_id_mask !== undefined) {
        maskedFrameId = frameId & canConfig.frame_id_mask;
      }
      // Extract header field values from CAN ID using mask + shift
      if (canConfig.fields) {
        for (const [name, field] of Object.entries(canConfig.fields)) {
          // Calculate shift from trailing zeros in mask if not explicitly provided
          // e.g., mask 0xFFFFF00 has 8 trailing zeros, so shift = 8
          let shift = field.shift;
          if (shift === undefined && field.mask > 0) {
            shift = 0;
            let m = field.mask;
            while ((m & 1) === 0 && m > 0) {
              shift++;
              m >>>= 1;
            }
          }
          const value = (frameId & field.mask) >>> (shift ?? 0);
          const format = field.format ?? 'hex';
          const display = format === 'decimal' ? String(value) : `0x${value.toString(16).toUpperCase()}`;
          headerFields.push({ name, value, display, format });

          // Check if this field is a source address field
          // Support common naming conventions: source_address, Sender, Source, src, SA
          const lowerName = name.toLowerCase();
          if (lowerName === 'source_address' || lowerName === 'sender' || lowerName === 'source' || lowerName === 'src' || lowerName === 'sa') {
            effectiveSourceAddress = value;
          }
        }
      }
    } else if (protocol === 'serial' && serialConfig) {
      // Apply frame_id_mask to serial frame ID before matching
      if (serialConfig.frame_id_mask !== undefined) {
        maskedFrameId = frameId & serialConfig.frame_id_mask;
      }
      // Extract serial header fields from frame bytes using mask-based definitions
      if (serialConfig.header_fields && serialConfig.header_fields.length > 0) {
        for (const field of serialConfig.header_fields) {
          // Skip 'id' field - it's already shown as the frame ID
          if (field.name === 'id') continue;

          // Extract value from bytes using start_byte and bytes (computed from mask)
          if (field.start_byte < bytes.length) {
            let value = 0;
            const endByte = Math.min(field.start_byte + field.bytes, bytes.length);

            if (field.byte_order === 'little') {
              // Little endian: LSB first
              for (let i = field.start_byte; i < endByte; i++) {
                value |= bytes[i] << ((i - field.start_byte) * 8);
              }
            } else {
              // Big endian (default): MSB first
              for (let i = field.start_byte; i < endByte; i++) {
                value = (value << 8) | bytes[i];
              }
            }

            // Apply mask to extract only the relevant bits
            // The mask is relative to header_length bytes, so we need to shift it
            const shiftedMask = field.mask >>> (field.start_byte * 8);
            value = value & shiftedMask;

            const format = field.format ?? 'hex';
            const display = format === 'decimal' ? String(value) : `0x${value.toString(16).toUpperCase()}`;
            headerFields.push({ name: field.name, value, display, format });
          }
        }
      }
    }

    const frame = frames.get(maskedFrameId);
    if (!frame) return;

    // Determine default byte order from catalog config
    // CAN config takes precedence, then serial config, then fall back to 'little'
    const defaultByteOrder: 'little' | 'big' =
      (protocol === 'can' ? canConfig?.default_byte_order : serialConfig?.default_byte_order) || 'little';

    // Capture current timestamp for signals
    const now = Date.now() / 1000; // epoch seconds

    // Capture stream start time from first decoded signal
    const { streamStartTimeSeconds } = get();
    if (streamStartTimeSeconds === null) {
      set({ streamStartTimeSeconds: now });
    }

    // Decode plain signals, passing catalog default byte order
    const plainDecoded = frame.signals.map((signal, idx) => {
      const decoded = decodeSignal(bytes, signal, signal.name || `Signal ${idx + 1}`, defaultByteOrder);
      return {
        name: decoded.name,
        value: decoded.display,
        unit: decoded.unit,
        format: signal.format,
        rawValue: decoded.value,
        timestamp: now,
      };
    });

    // Decode mux signals based on active case, passing default byte order and timestamp
    const muxResult = frame.mux
      ? decodeMuxSignals(bytes, frame.mux, defaultByteOrder, now)
      : { signals: [], selectors: [] };

    // Merge new decoded values with existing ones (preserve values from other mux cases)
    const existingFrame = _decoded.get(frameId);
    const existingSignals = existingFrame?.signals || [];

    // Helper to create a unique key for a signal
    // For mux signals, key by muxValue:name so each mux value's signals are tracked separately
    const signalKey = (signal: DecodedSignal) =>
      signal.muxValue !== undefined ? `${signal.muxValue}:${signal.name}` : signal.name;

    // Create a map of new values by unique key
    const newValues = new Map<string, DecodedSignal>();
    for (const signal of [...plainDecoded, ...muxResult.signals]) {
      newValues.set(signalKey(signal), signal);
    }

    // Merge: update existing signals with new values, keep old values for signals not in current frame
    const mergedSignals = new Map<string, DecodedSignal>();

    // Add all existing signals (keyed by muxValue:name for mux signals)
    for (const signal of existingSignals) {
      mergedSignals.set(signalKey(signal), signal);
    }

    // Then, update/add new signals (overwrites existing with same key)
    for (const [key, signal] of newValues) {
      mergedSignals.set(key, signal);
    }

    const decodedFrame: DecodedFrame = {
      signals: Array.from(mergedSignals.values()),
      rawBytes: bytes,
      headerFields,
      sourceAddress: effectiveSourceAddress,
      muxSelectors: muxResult.selectors.length > 0 ? muxResult.selectors : undefined,
    };

    // Mutate module-level LRU maps in place (avoids copying 500/2000-entry maps)
    // Store using masked ID to match catalog frame IDs
    _decoded.set(maskedFrameId, decodedFrame);

    // Also store in per-source map if sourceAddress is provided (from backend or extracted from CAN ID)
    if (effectiveSourceAddress !== undefined) {
      // Use masked ID for consistency with decoded map
      const perSourceKey = `${maskedFrameId}:${effectiveSourceAddress}`;
      _decodedPerSource.set(perSourceKey, decodedFrame);
    }

    // Accumulate header field values for filter options (persists across frame updates)
    const { seenHeaderFieldValues } = get();
    const nextSeenValues = new Map(seenHeaderFieldValues);
    for (const field of headerFields) {
      let fieldMap = nextSeenValues.get(field.name);
      if (!fieldMap) {
        fieldMap = new Map();
        nextSeenValues.set(field.name, fieldMap);
      }
      const existing = fieldMap.get(field.value);
      if (existing) {
        existing.count++;
      } else if (fieldMap.size < MAX_HEADER_FIELD_VALUES) {
        // Only add new values if under limit (prevents unbounded growth)
        fieldMap.set(field.value, { display: field.display, count: 1 });
      }
    }

    // Mirror validation: compare bytes between mirror and source frames
    const { mirrorSourceMap, mirrorValidation, mirrorFuzzWindowMs } = get();
    const nextMirrorValidation = new Map(mirrorValidation);

    // Check if this frame is a mirror (has a source it mirrors)
    const mirrorSourceId = mirrorSourceMap.get(maskedFrameId);

    // Find ALL mirrors that use this frame as a source (one source can have multiple mirrors)
    const mirrorsOfThisSource: number[] = [];
    for (const [mirrorId, sourceId] of mirrorSourceMap) {
      if (sourceId === maskedFrameId) {
        mirrorsOfThisSource.push(mirrorId);
      }
    }

    // Helper to update a validation entry
    const updateValidationEntry = (validationKey: number, sourceFrameId: number, mirrorFrameId: number, isMirrorFrame: boolean) => {
      // Calculate fuzz window based on frame interval
      const sourceFrame = frames.get(sourceFrameId);
      const frameInterval = sourceFrame?.interval ?? canConfig?.default_interval ?? mirrorFuzzWindowMs;
      const effectiveFuzzWindow = frameInterval * 2;

      // Get or create validation entry
      let entry = nextMirrorValidation.get(validationKey);
      if (!entry) {
        // Compute inherited byte indices from mirror frame definition
        const mirrorFrame = frames.get(mirrorFrameId);
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
          sourceFrameId,
          mirrorFrameId,
          lastMirrorBytes: [],
          lastMirrorTimestamp: 0,
          lastSourceBytes: [],
          lastSourceTimestamp: 0,
          isValid: null,
          timeDeltaMs: 0,
          inheritedByteIndices,
          mismatchedByteIndices: new Set(),
          consecutiveMismatches: 0,
        };
      }

      // Update appropriate side
      const validationTimestamp = frameTimestamp ?? now;
      if (isMirrorFrame) {
        entry.lastMirrorBytes = [...bytes];
        entry.lastMirrorTimestamp = validationTimestamp;
      } else {
        entry.lastSourceBytes = [...bytes];
        entry.lastSourceTimestamp = validationTimestamp;
      }

      // Check if we have both sides within fuzz window
      const timeDelta = Math.abs(entry.lastMirrorTimestamp - entry.lastSourceTimestamp) * 1000;
      entry.timeDeltaMs = timeDelta;

      if (entry.lastMirrorBytes.length > 0 && entry.lastSourceBytes.length > 0) {
        if (timeDelta <= effectiveFuzzWindow) {
          // Compare ONLY inherited signal bytes and track which ones mismatch
          const mismatched = new Set<number>();
          for (const idx of entry.inheritedByteIndices) {
            if (entry.lastMirrorBytes[idx] !== entry.lastSourceBytes[idx]) {
              mismatched.add(idx);
            }
          }
          entry.mismatchedByteIndices = mismatched;

          // Hysteresis: stay on Match unless we see several consecutive mismatches
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
        // Outside fuzz window: keep current state, don't reset
      }

      nextMirrorValidation.set(validationKey, entry);
    };

    // If this frame is a mirror, update its entry
    if (mirrorSourceId !== undefined) {
      updateValidationEntry(maskedFrameId, mirrorSourceId, maskedFrameId, true);
    }

    // If this frame is a source for any mirrors, update ALL their entries
    for (const mirrorId of mirrorsOfThisSource) {
      updateValidationEntry(mirrorId, maskedFrameId, mirrorId, false);
    }

    set({ decodedVersion: get().decodedVersion + 1, seenHeaderFieldValues: nextSeenValues, mirrorValidation: nextMirrorValidation });
  },

  decodeSignalsBatch: (framesToDecode, unmatchedToAdd, filteredToAdd) => {
    if (framesToDecode.length === 0 && unmatchedToAdd.length === 0 && filteredToAdd.length === 0) {
      return;
    }

    const { frames, protocol, canConfig, serialConfig, seenHeaderFieldValues, streamStartTimeSeconds, mirrorSourceMap, mirrorValidation, mirrorFuzzWindowMs } = get();

    // Mutate module-level LRU maps in place — avoids creating new 500/2000-entry
    // Maps every 100ms flush, which caused JSC GC pressure that crashed the WebView
    // after ~2 hours of streaming.
    const nextDecoded = _decoded;
    const nextDecodedPerSource = _decodedPerSource;
    const nextSeenValues = new Map(seenHeaderFieldValues);
    const nextMirrorValidation = new Map(mirrorValidation);
    let newStreamStartTime = streamStartTimeSeconds;

    // Pre-build reverse mirror map: sourceId → mirrorIds[]
    // Converts per-frame O(mirrorSourceMap.size) scan to O(1) lookup
    const reverseMirrorMap = new Map<number, number[]>();
    for (const [mirrorId, sourceId] of mirrorSourceMap) {
      const existing = reverseMirrorMap.get(sourceId);
      if (existing) {
        existing.push(mirrorId);
      } else {
        reverseMirrorMap.set(sourceId, [mirrorId]);
      }
    }

    // Determine default byte order from catalog config
    const defaultByteOrder: 'little' | 'big' =
      (protocol === 'can' ? canConfig?.default_byte_order : serialConfig?.default_byte_order) || 'little';

    // Capture current timestamp for signals
    const now = Date.now() / 1000;

    // Set stream start time if not already set
    if (newStreamStartTime === null && framesToDecode.length > 0) {
      newStreamStartTime = now;
    }

    // Helper to create a unique key for a signal
    const signalKey = (signal: DecodedSignal) =>
      signal.muxValue !== undefined ? `${signal.muxValue}:${signal.name}` : signal.name;

    // Process all frames to decode
    for (const { frameId, bytes, sourceAddress, timestamp } of framesToDecode) {
      // Apply frame_id_mask before catalog lookup
      let maskedFrameId = frameId;
      const headerFields: HeaderFieldValue[] = [];
      let effectiveSourceAddress = sourceAddress;

      if (protocol === 'can' && canConfig) {
        if (canConfig.frame_id_mask !== undefined) {
          maskedFrameId = frameId & canConfig.frame_id_mask;
        }
        if (canConfig.fields) {
          for (const [name, field] of Object.entries(canConfig.fields)) {
            let shift = field.shift;
            if (shift === undefined && field.mask > 0) {
              shift = 0;
              let m = field.mask;
              while ((m & 1) === 0 && m > 0) {
                shift++;
                m >>>= 1;
              }
            }
            const value = (frameId & field.mask) >>> (shift ?? 0);
            const format = field.format ?? 'hex';
            const display = format === 'decimal' ? String(value) : `0x${value.toString(16).toUpperCase()}`;
            headerFields.push({ name, value, display, format });

            const lowerName = name.toLowerCase();
            if (lowerName === 'source_address' || lowerName === 'sender' || lowerName === 'source' || lowerName === 'src' || lowerName === 'sa') {
              effectiveSourceAddress = value;
            }
          }
        }
      } else if (protocol === 'serial' && serialConfig) {
        if (serialConfig.frame_id_mask !== undefined) {
          maskedFrameId = frameId & serialConfig.frame_id_mask;
        }
        if (serialConfig.header_fields && serialConfig.header_fields.length > 0) {
          for (const field of serialConfig.header_fields) {
            if (field.name === 'id') continue;
            if (field.start_byte < bytes.length) {
              let value = 0;
              const endByte = Math.min(field.start_byte + field.bytes, bytes.length);
              if (field.byte_order === 'little') {
                for (let i = field.start_byte; i < endByte; i++) {
                  value |= bytes[i] << ((i - field.start_byte) * 8);
                }
              } else {
                for (let i = field.start_byte; i < endByte; i++) {
                  value = (value << 8) | bytes[i];
                }
              }
              const shiftedMask = field.mask >>> (field.start_byte * 8);
              value = value & shiftedMask;
              const format = field.format ?? 'hex';
              const display = format === 'decimal' ? String(value) : `0x${value.toString(16).toUpperCase()}`;
              headerFields.push({ name: field.name, value, display, format });
            }
          }
        }
      }

      const frame = frames.get(maskedFrameId);
      if (!frame) continue;

      // Decode plain signals
      const plainDecoded = frame.signals.map((signal, idx) => {
        const decoded = decodeSignal(bytes, signal, signal.name || `Signal ${idx + 1}`, defaultByteOrder);
        return {
          name: decoded.name,
          value: decoded.display,
          unit: decoded.unit,
          format: signal.format,
          rawValue: decoded.value,
          timestamp: now,
        };
      });

      // Decode mux signals
      const muxResult = frame.mux
        ? decodeMuxSignals(bytes, frame.mux, defaultByteOrder, now)
        : { signals: [], selectors: [] };

      // Merge with existing decoded values
      const existingFrame = nextDecoded.get(maskedFrameId);
      const existingSignals = existingFrame?.signals || [];

      const mergedSignals = new Map<string, DecodedSignal>();
      for (const signal of existingSignals) {
        mergedSignals.set(signalKey(signal), signal);
      }
      for (const signal of [...plainDecoded, ...muxResult.signals]) {
        mergedSignals.set(signalKey(signal), signal);
      }

      const decodedFrame: DecodedFrame = {
        signals: Array.from(mergedSignals.values()),
        rawBytes: bytes,
        headerFields,
        sourceAddress: effectiveSourceAddress,
        muxSelectors: muxResult.selectors.length > 0 ? muxResult.selectors : undefined,
      };

      nextDecoded.set(maskedFrameId, decodedFrame);

      if (effectiveSourceAddress !== undefined) {
        const perSourceKey = `${maskedFrameId}:${effectiveSourceAddress}`;
        nextDecodedPerSource.set(perSourceKey, decodedFrame);
      }

      // Accumulate header field values
      for (const field of headerFields) {
        let fieldMap = nextSeenValues.get(field.name);
        if (!fieldMap) {
          fieldMap = new Map();
          nextSeenValues.set(field.name, fieldMap);
        }
        const existing = fieldMap.get(field.value);
        if (existing) {
          existing.count++;
        } else if (fieldMap.size < MAX_HEADER_FIELD_VALUES) {
          // Only add new values if under limit (prevents unbounded growth)
          fieldMap.set(field.value, { display: field.display, count: 1 });
        }
      }

      // Mirror validation: compare bytes between mirror and source frames
      const mirrorSourceId = mirrorSourceMap.get(maskedFrameId);
      const mirrorsOfThisSource = reverseMirrorMap.get(maskedFrameId) ?? [];

      if (mirrorSourceId !== undefined || mirrorsOfThisSource.length > 0) {
        const updateValidationEntry = (validationKey: number, sourceFrameId: number, mirrorFrameId: number, isMirrorFrame: boolean) => {
          const sourceFrame = frames.get(sourceFrameId);
          const frameInterval = sourceFrame?.interval ?? canConfig?.default_interval ?? mirrorFuzzWindowMs;
          const effectiveFuzzWindow = frameInterval * 2;

          let entry = nextMirrorValidation.get(validationKey);
          if (!entry) {
            const mirrorFrame = frames.get(mirrorFrameId);
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
    if (unmatchedToAdd.length > 0) {
      _unmatchedFrames.push(...unmatchedToAdd);
      if (_unmatchedFrames.length > MAX_UNMATCHED_FRAMES) {
        _unmatchedFrames = _unmatchedFrames.slice(-MAX_UNMATCHED_FRAMES);
      }
    }

    // Add filtered frames in place (with limit)
    if (filteredToAdd.length > 0) {
      _filteredFrames.push(...filteredToAdd);
      if (_filteredFrames.length > MAX_FILTERED_FRAMES) {
        _filteredFrames = _filteredFrames.slice(-MAX_FILTERED_FRAMES);
      }
    }

    // Single state update — version counter drives reactivity for decoded/unmatched/filtered
    set({
      decodedVersion: get().decodedVersion + 1,
      seenHeaderFieldValues: nextSeenValues,
      streamStartTimeSeconds: newStreamStartTime,
      mirrorValidation: nextMirrorValidation,
    });
  },

  addUnmatchedFrame: (frame) => {
    _unmatchedFrames.push(frame);
    if (_unmatchedFrames.length > MAX_UNMATCHED_FRAMES) {
      _unmatchedFrames.splice(0, _unmatchedFrames.length - MAX_UNMATCHED_FRAMES);
    }
    set({ decodedVersion: get().decodedVersion + 1 });
  },

  clearUnmatchedFrames: () => {
    _unmatchedFrames = [];
    set({ decodedVersion: get().decodedVersion + 1 });
  },

  addFilteredFrame: (frame) => {
    _filteredFrames.push(frame);
    if (_filteredFrames.length > MAX_FILTERED_FRAMES) {
      _filteredFrames.splice(0, _filteredFrames.length - MAX_FILTERED_FRAMES);
    }
    set({ decodedVersion: get().decodedVersion + 1 });
  },

  clearFilteredFrames: () => {
    _filteredFrames = [];
    set({ decodedVersion: get().decodedVersion + 1 });
  },

  setIoProfile: (profile) => {
    _decoded = new LRUMap(MAX_DECODED_FRAMES);
    _decodedPerSource = new LRUMap(MAX_DECODED_PER_SOURCE);
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

    const selectedFramesList = Array.from(frames.values())
      .filter((f) => selectedFrames.has(f.id))
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
    const idsToSelect = selectionSet.selectedIds ?? selectionSet.frameIds;
    const newSelectedFrames = new Set<number>();

    for (const frameId of idsToSelect) {
      newSelectedFrames.add(frameId);
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
