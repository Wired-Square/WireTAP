// ui/src/stores/discoverySerialStore.ts
//
// Serial bytes and framing state for Discovery app.
// Handles raw byte display, client-side framing, and frame ID mapping.
// Supports backend capture mode for large captures (bytes stored in Rust).

import { create } from 'zustand';
import { tlog } from '../api/settings';
import type { FrameMessage } from '../types/frame';
import {
  applyFramingToCapture,
  deleteCapture,
  type BackendFramingConfig,
} from '../api/capture';
import type { PageSize } from '../utils/pageSize';
import type { ModbusFramingSettings } from '../components/FramingOptionsPanel';

/** A single byte with timestamp for hex dump display */
export type SerialBytesEntry = {
  byte: number;
  timestampUs: number;
  /** Bus/interface number (for multi-source sessions) */
  bus?: number;
};

/** Framing configuration for client-side framing */
export type FramingConfig = {
  mode: 'raw' | 'modbus_rtu' | 'slip';
  /** For raw mode: delimiter bytes (hex string like "0A" or "0D0A") */
  delimiter?: string;
  /** For raw mode: max frame length before forced split */
  maxLength?: number;
} & ModbusFramingSettings;

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

/** Serial view tab IDs (string to support dynamic tool output tabs) */
export type SerialTabId = string;

interface DiscoverySerialState {
  // Serial bytes state
  isSerialMode: boolean;
  framingConfig: FramingConfig | null;
  framedData: FrameMessage[];
  framingAccepted: boolean;
  rawBytesViewConfig: RawBytesViewConfig;
  serialViewConfig: SerialViewConfig;
  activeTab: SerialTabId;

  // Pagination state for framed data view
  framedPageSize: PageSize;

  // Backend capture mode state. The byte capture's id and count are the session's
  // (sessionStore, pushed by Rust) — only what is derived from it lives here.
  /** Rows per page for the raw bytes view. A plain count — ByteView offers no Auto. */
  rawBytesPageSize: number;
  /** ID of the frame capture created by backend framing (null = no framing applied) */
  framedCaptureId: string | null;
  /** Frame count from backend framing (updated each time framing is applied) */
  backendFrameCount: number;
  /** Minimum frame length filter (0 = no filter, independent of framing mode) */
  minFrameLength: number;
  /** Trigger counter to force FramedDataView to re-fetch (incremented after applyFraming) */
  framedDataTrigger: number;
  /** Frame ID extraction config (passed to backend framing) */
  frameIdExtractionConfig: ByteExtractionConfig | null;
  /** Source address extraction config (passed to backend framing) */
  sourceExtractionConfig: ByteExtractionConfig | null;
  /** Frames excluded by minFrameLength filter (from backend framing) */
  filteredFrames: FrameMessage[];
  /** Count of filtered frames in backend capture */
  filteredFrameCount: number;
  /** ID of the filtered frame capture created by backend framing */
  filteredCaptureId: string | null;

  // Actions
  setSerialMode: (enabled: boolean) => void;
  clearSerialBytes: () => void;
  setFramingConfig: (config: FramingConfig | null) => Promise<void>;
  applyFraming: (streamStartTimeUs: number | null, sessionId?: string) => Promise<FrameMessage[]>;
  acceptFraming: () => FrameMessage[];
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
  // Backend frame count actions (for real-time streaming with backend framing)
  incrementBackendFrameCount: (delta: number) => void;
  setBackendFrameCount: (count: number) => void;
}

export const useDiscoverySerialStore = create<DiscoverySerialState>((set, get) => ({
  // Initial state
  isSerialMode: false,
  framingConfig: null,
  framedData: [],
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
  framedCaptureId: null, // ID of backend frame capture
  backendFrameCount: 0, // Frame count from backend framing
  minFrameLength: 0, // 0 = no filter
  framedDataTrigger: 0, // Incremented to force FramedDataView refetch
  frameIdExtractionConfig: null, // Frame ID extraction config
  sourceExtractionConfig: null, // Source address extraction config
  filteredFrames: [], // Frames excluded by minFrameLength filter
  filteredFrameCount: 0, // Count of filtered frames
  filteredCaptureId: null, // ID of filtered frame capture

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
      framedData: [],
      framingAccepted: false,
      activeTab: 'raw',
      framedCaptureId: null,
      backendFrameCount: 0,
      minFrameLength: 0,
      frameIdExtractionConfig: null,
      sourceExtractionConfig: null,
      filteredFrames: [],
      filteredFrameCount: 0,
      filteredCaptureId: null,
    });
  },

  clearSerialBytes: () => {
    // Drop the framing derived from whatever capture this view was showing. The
    // captures themselves are Rust's to keep or delete.
    set({
      framedData: [],
      framingAccepted: false,
      framedCaptureId: null,
      backendFrameCount: 0,
      minFrameLength: 0,
      filteredFrames: [],
      filteredFrameCount: 0,
      filteredCaptureId: null,
    });
  },

  setFramingConfig: async (config) => {
    const { framedCaptureId: previousCaptureId } = get();

    // If clearing framing (config is null), delete the framed capture and switch to raw tab
    if (config === null && previousCaptureId) {
      try {
        await deleteCapture(previousCaptureId);
      } catch (e) {
        tlog.info(`[discoverySerialStore] Failed to delete framed capture: ${e}`);
      }
      set({
        framingConfig: null,
        framingAccepted: false,
        framedData: [],
        framedCaptureId: null,
        backendFrameCount: 0,
        activeTab: 'raw', // Switch back to HexDump view
      });
    } else {
      set({ framingConfig: config, framingAccepted: false });
    }
  },

  applyFraming: async (_streamStartTimeUs, sessionId) => {
    const { framingConfig, framedCaptureId: previousCaptureId, filteredCaptureId: previousFilteredCaptureId, minFrameLength, frameIdExtractionConfig, sourceExtractionConfig } = get();
    if (!framingConfig) {
      set({ framedData: [], framedCaptureId: null, backendFrameCount: 0, filteredFrameCount: 0, filteredCaptureId: null, filteredFrames: [] });
      return [];
    }

    // Build backend framing config
    // Use independent minFrameLength from store (0 means no filter)
    // Include frame ID and source extraction configs if set
    const backendConfig: BackendFramingConfig = {
      mode: framingConfig.mode,
      delimiter: framingConfig.delimiter,
      max_length: framingConfig.maxLength,
      modbus: {
        validate_crc: framingConfig.validateCrc,
        device_address: framingConfig.deviceAddress,
        vendor_functions: framingConfig.vendorFunctions,
        allow_broadcast: framingConfig.allowBroadcast,
        any_function: framingConfig.anyFunction,
      },
      min_length: minFrameLength > 0 ? minFrameLength : undefined,
      frame_id_config: frameIdExtractionConfig ? {
        start_byte: frameIdExtractionConfig.startByte,
        num_bytes: frameIdExtractionConfig.numBytes,
        big_endian: frameIdExtractionConfig.endianness === 'big',
      } : undefined,
      source_address_config: sourceExtractionConfig ? {
        start_byte: sourceExtractionConfig.startByte,
        num_bytes: sourceExtractionConfig.numBytes,
        big_endian: sourceExtractionConfig.endianness === 'big',
      } : undefined,
    };

    try {
      // Call backend to apply framing - this creates a new frame capture.
      // Both previous capture IDs go back so they are refilled rather than
      // re-derived; framing runs on every stop, so a capture per run adds up.
      const result = await applyFramingToCapture(
        sessionId ?? '',
        backendConfig,
        previousCaptureId,
        previousFilteredCaptureId,
      );

      tlog.info(`[discoverySerialStore] Framed ${framingConfig.mode}: ${result.frame_count} frames, ${result.filtered_count} filtered`);

      // Store the capture ID and frame count for FramedDataView
      // Also store filtered frame count and capture ID for the Filtered tab
      // Note: We don't fetch the frames here - FramedDataView will use pagination
      // Increment framedDataTrigger to force refetch even if capture ID/count unchanged
      set((state) => ({
        framedCaptureId: result.capture_id,
        backendFrameCount: result.frame_count,
        filteredFrameCount: result.filtered_count,
        filteredCaptureId: result.filtered_capture_id,
        framedDataTrigger: state.framedDataTrigger + 1,
        // Clear local framedData since frames are now in backend
        framedData: [],
        filteredFrames: [],
      }));

      // Return empty array - frames are fetched via pagination in FramedDataView
      // The caller can check framedCaptureId to know if framing succeeded
      return [];
    } catch (error) {
      tlog.info(`[discoverySerialStore] Failed to apply framing in backend: ${error}`);
      set({ framedData: [], framedCaptureId: null, backendFrameCount: 0, filteredFrameCount: 0, filteredCaptureId: null, filteredFrames: [] });
      return [];
    }
  },

  acceptFraming: () => {
    const { framedData, framedCaptureId, backendFrameCount } = get();

    // Check if we have frames - either locally, in backend capture, or streaming frames
    const hasLocalFrames = framedData.length > 0;
    const hasBackendFrames = framedCaptureId !== null && backendFrameCount > 0;
    // Also check for streaming mode where frames go directly to mainFrames
    // (backendFrameCount tracks streaming frames even without framedCaptureId)
    const hasStreamingFrames = framedCaptureId === null && backendFrameCount > 0;

    if (!hasLocalFrames && !hasBackendFrames && !hasStreamingFrames) return [];

    // Clear serial bytes since they've been processed
    set({ framingAccepted: true });

    return framedData;
  },

  resetFraming: () => {
    set({
      framingConfig: null,
      framedData: [],
      framingAccepted: false,
      framedCaptureId: null,
      backendFrameCount: 0,
      frameIdExtractionConfig: null,
      sourceExtractionConfig: null,
      filteredFrames: [],
      filteredFrameCount: 0,
      filteredCaptureId: null,
    });
  },

  undoAcceptFraming: () => {
    // Just un-accept framing, keep all config intact so user can reconfigure
    set({ framingAccepted: false });
  },

  applyFrameIdMapping: (config) => {
    const { framedData, framingAccepted } = get();

    // Always store the config for backend framing
    set({ frameIdExtractionConfig: config });

    // Only update local framedData if not accepted and we have data
    if (framingAccepted || framedData.length === 0) return;

    const extractFrameId = (bytes: number[]): number => {
      const { startByte, numBytes, endianness } = config;
      // Resolve negative indices (e.g., -1 = last byte)
      const resolvedStart = startByte >= 0 ? startByte : Math.max(0, bytes.length + startByte);
      if (resolvedStart >= bytes.length) return 0;

      let frameId = 0;
      const endByte = Math.min(resolvedStart + numBytes, bytes.length);

      if (endianness === 'big') {
        for (let i = resolvedStart; i < endByte; i++) {
          frameId = (frameId << 8) | bytes[i];
        }
      } else {
        for (let i = resolvedStart; i < endByte; i++) {
          frameId |= bytes[i] << (8 * (i - resolvedStart));
        }
      }

      return frameId;
    };

    const updatedFramedData = framedData.map(frame => ({
      ...frame,
      frame_id: extractFrameId(frame.bytes),
    }));
    set({ framedData: updatedFramedData });
  },

  clearFrameIdMapping: () => {
    const { framedData, framingAccepted } = get();

    // Clear the stored config
    set({ frameIdExtractionConfig: null });

    if (framingAccepted || framedData.length === 0) return;

    const updatedFramedData = framedData.map(frame => ({
      ...frame,
      frame_id: 0,
    }));
    set({ framedData: updatedFramedData });
  },

  applySourceMapping: (config) => {
    const { framedData, framingAccepted } = get();

    // Always store the config for backend framing
    set({ sourceExtractionConfig: config });

    // Only update local framedData if not accepted and we have data
    if (framingAccepted || framedData.length === 0) return;

    const extractSource = (bytes: number[]): number => {
      const { startByte, numBytes, endianness } = config;
      // Resolve negative indices (e.g., -1 = last byte)
      const resolvedStart = startByte >= 0 ? startByte : Math.max(0, bytes.length + startByte);
      if (resolvedStart >= bytes.length) return 0;

      let source = 0;
      const endByte = Math.min(resolvedStart + numBytes, bytes.length);

      if (endianness === 'big') {
        for (let i = resolvedStart; i < endByte; i++) {
          source = (source << 8) | bytes[i];
        }
      } else {
        for (let i = resolvedStart; i < endByte; i++) {
          source |= bytes[i] << (8 * (i - resolvedStart));
        }
      }

      return source;
    };

    const updatedFramedData = framedData.map(frame => ({
      ...frame,
      source_address: extractSource(frame.bytes),
    }));
    set({ framedData: updatedFramedData });
  },

  clearSourceMapping: () => {
    const { framedData, framingAccepted } = get();

    // Clear the stored config
    set({ sourceExtractionConfig: null });

    if (framingAccepted || framedData.length === 0) return;

    const updatedFramedData = framedData.map(frame => ({
      ...frame,
      source_address: undefined,
    }));
    set({ framedData: updatedFramedData });
  },

  setRawBytesViewConfig: (config) => set({ rawBytesViewConfig: config }),

  setSerialViewConfig: (config) => set({ serialViewConfig: config }),

  toggleShowAscii: () => set((state) => ({
    serialViewConfig: { ...state.serialViewConfig, showAscii: !state.serialViewConfig.showAscii }
  })),

  setActiveTab: (tab) => set({ activeTab: tab }),

  setFramedPageSize: (size) => set({ framedPageSize: size }),

  setRawBytesPageSize: (size) => set({ rawBytesPageSize: size }),

  setMinFrameLength: (length) => set({ minFrameLength: length }),

  // Backend frame count actions (for real-time streaming with backend framing)
  incrementBackendFrameCount: (delta) => set((state) => ({
    backendFrameCount: state.backendFrameCount + delta,
  })),

  setBackendFrameCount: (count) => set({ backendFrameCount: count }),
}));
