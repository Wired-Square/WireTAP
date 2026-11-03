// ui/src/stores/discoverySerialStore.ts
//
// Serial bytes and framing state for Discovery app.
// Handles raw byte display, client-side framing, and frame ID mapping.
// Supports backend capture mode for large captures (bytes stored in Rust).

import { create } from '@wired-square/store/react';
import type { FrameMessage } from '../types/frame';
import { extractSerialIds, toFrameIdConfig, type BackendFramingConfig } from '../api/capture';
import type { FramingStateMsg } from '../generated/FramingStateMsg';
import type { PageSize } from '../utils/pageSize';
import type { FramingPanelConfig } from '../components/FramingOptionsPanel';

/** A single byte with timestamp for hex dump display */
export type SerialBytesEntry = {
  byte: number;
  timestampUs: number;
  /** Bus/interface number (for multi-source sessions) */
  bus?: number;
};

/** Framing configuration for client-side framing; null is no framing */
export type FramingConfig = FramingPanelConfig;

/** Raw bytes view display mode */
export type RawBytesDisplayMode = 'individual' | 'chunked';

/** Raw bytes view configuration */
export type RawBytesViewConfig = {
  /** Display mode: individual bytes with their timing, or chunked bytes with first byte timing */
  displayMode: RawBytesDisplayMode;
  /** Gap threshold in microseconds - bytes arriving within this gap are chunked together */
  chunkGapUs: number;
};

/** Serial view display configuration (shared between raw bytes and framed data) */
export type SerialViewConfig = {
  /** Show ASCII column in tables */
  showAscii: boolean;
};

/** Byte extraction configuration for frame ID or source address */
export type ByteExtractionConfig = {
  startByte: number;
  numBytes: number;
  endianness: 'big' | 'little';
};

/** The capture the Framed tab reads, the frames in it, and who framed them. */
export type FramedSource = {
  captureId: string | null;
  frameCount: number;
  /** Framed on the wire by the reader (SLIP, Modbus RTU), so the client-side filter has nothing to filter. */
  readerFramed: boolean;
};

/**
 * The capture Rust frames the session's bytes into when framing is set, else the
 * session's own frame capture. One decision, so the id and the count cannot come
 * from different sides.
 */
export function framedSource(
  framing: FramingStateMsg | null,
  session: { captureId: string | null; frameCount: number },
): FramedSource {
  if (framing) {
    return { captureId: framing.framed_capture_id, frameCount: framing.frame_count, readerFramed: false };
  }
  const readerFramed = session.captureId !== null;
  return { captureId: session.captureId, frameCount: readerFramed ? session.frameCount : 0, readerFramed };
}

/**
 * The frames with the ids these configs name, extracted by the backend. A frame
 * too short to hold its id keeps the one it came with.
 */
export async function withSerialIds<T extends FrameMessage>(
  frames: T[],
  idConfig: ByteExtractionConfig | null,
  srcConfig: ByteExtractionConfig | null,
): Promise<T[]> {
  if ((!idConfig && !srcConfig) || frames.length === 0) return frames;
  const ids = await extractSerialIds(
    frames.map((f) => f.bytes),
    toFrameIdConfig(idConfig),
    toFrameIdConfig(srcConfig),
  );
  return frames.map((frame, i) => {
    const frameId = idConfig ? ids[i].frame_id : null;
    return {
      ...frame,
      // An extracted id names no unit and function, so it renders as a serial frame's.
      ...(frameId != null && { frame_id: frameId, protocol: 'serial' }),
      source_address: srcConfig ? ids[i].source_address ?? undefined : frame.source_address,
    };
  });
}

/** The framing Rust applies to the stored bytes, from the dialog's settings; 0 is no minimum length. */
export function backendFramingConfig(
  framing: FramingConfig,
  minFrameLength: number,
  idConfig: ByteExtractionConfig | null,
  srcConfig: ByteExtractionConfig | null,
): BackendFramingConfig {
  return {
    mode: framing.mode,
    delimiter: framing.delimiterHex,
    max_length: framing.maxFrameLength,
    modbus: {
      validate_crc: framing.validateCrc,
      device_address: framing.deviceAddress,
      vendor_functions: framing.vendorFunctions,
      allow_broadcast: framing.allowBroadcast,
      any_function: framing.anyFunction,
    },
    min_length: minFrameLength > 0 ? minFrameLength : undefined,
    frame_id_config: toFrameIdConfig(idConfig),
    source_address_config: toFrameIdConfig(srcConfig),
  };
}

/** Serial view tab IDs (string to support dynamic tool output tabs) */
export type SerialTabId = string;

interface DiscoverySerialState {
  // Serial bytes state
  isSerialMode: boolean;
  framingConfig: FramingConfig | null;
  framingAccepted: boolean;
  rawBytesViewConfig: RawBytesViewConfig;
  serialViewConfig: SerialViewConfig;
  activeTab: SerialTabId;

  // Pagination state for framed data view
  framedPageSize: PageSize;

  // The framing asked for. What Rust framed with it is the session's (`Session.framing`).
  /** Rows per page for the raw bytes view. A plain count — ByteView offers no Auto. */
  rawBytesPageSize: number;
  /** Minimum frame length filter (0 = no filter, independent of framing mode) */
  minFrameLength: number;
  /** Frame ID extraction config (passed to backend framing) */
  frameIdExtractionConfig: ByteExtractionConfig | null;
  /** Source address extraction config (passed to backend framing) */
  sourceExtractionConfig: ByteExtractionConfig | null;

  // Actions
  setSerialMode: (enabled: boolean) => void;
  clearSerialBytes: () => void;
  setFramingConfig: (config: FramingConfig | null) => void;
  acceptFraming: () => void;
  resetFraming: () => void;
  undoAcceptFraming: () => void;
  applyFrameIdMapping: (config: ByteExtractionConfig) => void;
  clearFrameIdMapping: () => void;
  applySourceMapping: (config: ByteExtractionConfig) => void;
  clearSourceMapping: () => void;
  setRawBytesViewConfig: (config: RawBytesViewConfig) => void;
  setSerialViewConfig: (config: SerialViewConfig) => void;
  toggleShowAscii: () => void;
  setActiveTab: (tab: SerialTabId) => void;
  setFramedPageSize: (size: PageSize) => void;
  setRawBytesPageSize: (size: number) => void;
  // Filter actions
  setMinFrameLength: (length: number) => void;
}

export const useDiscoverySerialStore = create<DiscoverySerialState>((set, get) => ({
  // Initial state
  isSerialMode: false,
  framingConfig: null,
  framingAccepted: false,
  rawBytesViewConfig: {
    displayMode: 'chunked',
    chunkGapUs: 1000, // 1ms default gap threshold
  },
  serialViewConfig: {
    showAscii: true, // Show ASCII column by default
  },
  activeTab: 'raw',
  framedPageSize: "auto", // Default page size for framed data
  rawBytesPageSize: 1000, // Default page size for raw bytes view
  minFrameLength: 0, // 0 = no filter
  frameIdExtractionConfig: null, // Frame ID extraction config
  sourceExtractionConfig: null, // Source address extraction config

  // Actions
  setSerialMode: (enabled) => {
    const { isSerialMode: currentMode } = get();
    // Only reset state when actually changing modes, not when setting to the same value
    if (currentMode === enabled) {
      return; // No change, don't reset state
    }
    set({
      isSerialMode: enabled,
      framingConfig: null,
      framingAccepted: false,
      activeTab: 'raw',
      minFrameLength: 0,
      frameIdExtractionConfig: null,
      sourceExtractionConfig: null,
    });
  },

  clearSerialBytes: () => {
    // The derived captures are Rust's to keep or delete.
    set({ framingAccepted: false, minFrameLength: 0 });
  },

  setFramingConfig: (config) =>
    set(config === null ? { framingConfig: null, framingAccepted: false, activeTab: 'raw' } : { framingConfig: config, framingAccepted: false }),

  acceptFraming: () => set({ framingAccepted: true }),

  resetFraming: () => {
    set({
      framingConfig: null,
      framingAccepted: false,
      frameIdExtractionConfig: null,
      sourceExtractionConfig: null,
    });
  },

  undoAcceptFraming: () => {
    // Just un-accept framing, keep all config intact so user can reconfigure
    set({ framingAccepted: false });
  },

  applyFrameIdMapping: (config) => set({ frameIdExtractionConfig: config }),

  clearFrameIdMapping: () => set({ frameIdExtractionConfig: null }),

  applySourceMapping: (config) => set({ sourceExtractionConfig: config }),

  clearSourceMapping: () => set({ sourceExtractionConfig: null }),

  setRawBytesViewConfig: (config) => set({ rawBytesViewConfig: config }),

  setSerialViewConfig: (config) => set({ serialViewConfig: config }),

  toggleShowAscii: () => set((state) => ({
    serialViewConfig: { ...state.serialViewConfig, showAscii: !state.serialViewConfig.showAscii }
  })),

  setActiveTab: (tab) => set({ activeTab: tab }),

  setFramedPageSize: (size) => set({ framedPageSize: size }),

  setRawBytesPageSize: (size) => set({ rawBytesPageSize: size }),

  setMinFrameLength: (length) => set({ minFrameLength: length }),
}));
