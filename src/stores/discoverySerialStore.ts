// ui/src/stores/discoverySerialStore.ts
//
// Serial bytes and framing state for Discovery app.
// Handles raw byte display, client-side framing, and frame ID mapping.
// Supports backend buffer mode for large captures (bytes stored in Rust).

import { create } from 'zustand';
import { tlog } from '../api/settings';
import type { FrameMessage } from '../types/frame';
import {
  getBufferBytesPaginated,
  applyFramingToBuffer,
  deleteBuffer,
  type PaginatedBytesResponse,
  type BackendFramingConfig,
} from '../api/buffer';

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
  /** For modbus_rtu mode: validate CRC */
  validateCrc?: boolean;
};

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

/** Serial view tab IDs */
export type SerialTabId = 'raw' | 'framed' | 'filtered' | 'analysis';

// Buffer limits
const MAX_SERIAL_BYTES = 100000;
const MAX_DISPLAY_ENTRIES = 10000;

interface DiscoverySerialState {
  // Serial bytes state
  serialBytes: SerialBytesEntry[];
  serialBytesBuffer: number[];
  isSerialMode: boolean;
  framingConfig: FramingConfig | null;
  framedData: FrameMessage[];
  framingAccepted: boolean;
  rawBytesViewConfig: RawBytesViewConfig;
  serialViewConfig: SerialViewConfig;
  activeTab: SerialTabId;

  // Pagination state for framed data view
  framedPageSize: number;  // 20, 50, 100, 1000, 10000, -1 (All)

  // Backend buffer mode state
  /** Total byte count in backend buffer (updated during streaming) */
  backendByteCount: number;
  /** Pagination state for raw bytes view */
  rawBytesPageSize: number;
  /** ID of the frame buffer created by backend framing (null = no framing applied) */
  framedBufferId: string | null;
  /** Frame count from backend framing (updated each time framing is applied) */
  backendFrameCount: number;
  /** Minimum frame length filter (0 = no filter, independent of framing mode) */
  minFrameLength: number;
  /** Trigger counter to force HexDump to re-fetch (incremented after setActiveBuffer) */
  bufferReadyTrigger: number;
  /** Trigger counter to force FramedDataView to re-fetch (incremented after applyFraming) */
  framedDataTrigger: number;
  /** Frame ID extraction config (passed to backend framing) */
  frameIdExtractionConfig: ByteExtractionConfig | null;
  /** Source address extraction config (passed to backend framing) */
  sourceExtractionConfig: ByteExtractionConfig | null;
  /** Frames excluded by minFrameLength filter (from backend framing) */
  filteredFrames: FrameMessage[];
  /** Count of filtered frames in backend buffer */
  filteredFrameCount: number;
  /** ID of the filtered frame buffer created by backend framing */
  filteredBufferId: string | null;

  // Actions
  setSerialMode: (enabled: boolean) => void;
  addSerialBytes: (entries: SerialBytesEntry[]) => void;
  clearSerialBytes: (preserveBackendCount?: boolean) => void;
  setFramingConfig: (config: FramingConfig | null) => Promise<void>;
  applyFraming: (streamStartTimeUs: number | null) => Promise<FrameMessage[]>;
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
  setFramedPageSize: (size: number) => void;
  // Backend buffer actions
  setBackendByteCount: (count: number) => void;
  incrementBackendByteCount: (delta: number) => void;
  fetchBytesFromBackend: (offset: number, limit: number) => Promise<PaginatedBytesResponse>;
  setRawBytesPageSize: (size: number) => void;
  triggerBufferReady: () => void;
  // Filter actions
  setMinFrameLength: (length: number) => void;
  // Backend frame count actions (for real-time streaming with backend framing)
  incrementBackendFrameCount: (delta: number) => void;
  setBackendFrameCount: (count: number) => void;
}

export const useDiscoverySerialStore = create<DiscoverySerialState>((set, get) => ({
  // Initial state
  serialBytes: [],
  serialBytesBuffer: [],
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
  framedPageSize: 100, // Default page size for framed data
  backendByteCount: 0, // Total bytes in backend buffer
  rawBytesPageSize: 1000, // Default page size for raw bytes view
  framedBufferId: null, // ID of backend frame buffer
  backendFrameCount: 0, // Frame count from backend framing
  minFrameLength: 0, // 0 = no filter
  bufferReadyTrigger: 0, // Incremented to force HexDump refetch
  framedDataTrigger: 0, // Incremented to force FramedDataView refetch
  frameIdExtractionConfig: null, // Frame ID extraction config
  sourceExtractionConfig: null, // Source address extraction config
  filteredFrames: [], // Frames excluded by minFrameLength filter
  filteredFrameCount: 0, // Count of filtered frames
  filteredBufferId: null, // ID of filtered frame buffer

  // Actions
  setSerialMode: (enabled) => {
    const { isSerialMode: currentMode } = get();
    // Only reset state when actually changing modes, not when setting to the same value
    if (currentMode === enabled) {
      return; // No change, don't reset state
    }
    set({
      isSerialMode: enabled,
      serialBytes: [],
      serialBytesBuffer: [],
      framingConfig: null,
      framedData: [],
      framingAccepted: false,
      activeTab: 'raw',
      backendByteCount: 0,
      framedBufferId: null,
      backendFrameCount: 0,
      minFrameLength: 0,
      frameIdExtractionConfig: null,
      sourceExtractionConfig: null,
      filteredFrames: [],
      filteredFrameCount: 0,
      filteredBufferId: null,
    });
  },

  addSerialBytes: (entries) => {
    const { serialBytes, serialBytesBuffer } = get();

    // Append to entries list for hex dump display
    const newSerialBytes = [...serialBytes, ...entries];

    // Append to flat buffer for framing (just the byte values)
    const newSerialBytesBuffer = [...serialBytesBuffer, ...entries.map(e => e.byte)];

    // Trim if over limit
    if (newSerialBytesBuffer.length > MAX_SERIAL_BYTES) {
      const removeCount = newSerialBytesBuffer.length - MAX_SERIAL_BYTES;
      newSerialBytesBuffer.splice(0, removeCount);
    }

    set({
      serialBytes: newSerialBytes.slice(-MAX_DISPLAY_ENTRIES),
      serialBytesBuffer: newSerialBytesBuffer,
    });
  },

  clearSerialBytes: (preserveBackendCount = false) => {
    // Clear frontend state only - does NOT clear backend buffers
    // The backend buffers are preserved so they can be used for replay/analysis
    // Call clearBackendBuffer() separately when you want to delete all buffers
    //
    // preserveBackendCount: When true, keeps backendByteCount so HexDump continues
    // to show data from the backend buffer. Use this when transitioning from streaming
    // to buffer mode where we want to keep displaying the buffer contents.
    set((state) => ({
      serialBytes: [],
      serialBytesBuffer: [],
      framedData: [],
      framingAccepted: false,
      backendByteCount: preserveBackendCount ? state.backendByteCount : 0,
      framedBufferId: null,
      backendFrameCount: 0,
      minFrameLength: 0,
      // Reset trigger when clearing for a fresh capture (but preserve when transitioning to buffer mode)
      bufferReadyTrigger: preserveBackendCount ? state.bufferReadyTrigger : 0,
      filteredFrames: [],
      filteredFrameCount: 0,
      filteredBufferId: null,
    }));
  },

  setFramingConfig: async (config) => {
    const { framedBufferId: previousBufferId } = get();

    // If clearing framing (config is null), delete the framed buffer and switch to raw tab
    if (config === null && previousBufferId) {
      try {
        await deleteBuffer(previousBufferId);
      } catch (e) {
        tlog.info(`[discoverySerialStore] Failed to delete framed buffer: ${e}`);
      }
      set({
        framingConfig: null,
        framingAccepted: false,
        framedData: [],
        framedBufferId: null,
        backendFrameCount: 0,
        activeTab: 'raw', // Switch back to HexDump view
      });
    } else {
      set({ framingConfig: config, framingAccepted: false });
    }
  },

  applyFraming: async (_streamStartTimeUs) => {
    const { backendByteCount, framingConfig, framedBufferId: previousBufferId, minFrameLength, frameIdExtractionConfig, sourceExtractionConfig } = get();
    if (!framingConfig) {
      set({ framedData: [], framedBufferId: null, backendFrameCount: 0, filteredFrameCount: 0, filteredBufferId: null, filteredFrames: [] });
      return [];
    }

    if (backendByteCount === 0) {
      set({ framedData: [], framedBufferId: null, backendFrameCount: 0, filteredFrameCount: 0, filteredBufferId: null, filteredFrames: [] });
      return [];
    }

    // Build backend framing config
    // Use independent minFrameLength from store (0 means no filter)
    // Include frame ID and source extraction configs if set
    const backendConfig: BackendFramingConfig = {
      mode: framingConfig.mode,
      delimiter: framingConfig.delimiter,
      max_length: framingConfig.maxLength,
      validate_crc: framingConfig.validateCrc,
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
      // Call backend to apply framing - this creates a new frame buffer
      // Pass previous buffer ID to reuse it (avoids buffer proliferation during live framing)
      const result = await applyFramingToBuffer(backendConfig, previousBufferId);

      // Store the buffer ID and frame count for FramedDataView
      // Also store filtered frame count and buffer ID for the Filtered tab
      // Note: We don't fetch the frames here - FramedDataView will use pagination
      // Increment framedDataTrigger to force refetch even if buffer ID/count unchanged
      set((state) => ({
        framedBufferId: result.buffer_id,
        backendFrameCount: result.frame_count,
        filteredFrameCount: result.filtered_count,
        filteredBufferId: result.filtered_buffer_id,
        framedDataTrigger: state.framedDataTrigger + 1,
        // Clear local framedData since frames are now in backend
        framedData: [],
        filteredFrames: [],
      }));

      // Return empty array - frames are fetched via pagination in FramedDataView
      // The caller can check framedBufferId to know if framing succeeded
      return [];
    } catch (error) {
      tlog.info(`[discoverySerialStore] Failed to apply framing in backend: ${error}`);
      set({ framedData: [], framedBufferId: null, backendFrameCount: 0, filteredFrameCount: 0, filteredBufferId: null, filteredFrames: [] });
      return [];
    }
  },

  acceptFraming: () => {
    const { framedData, framedBufferId, backendFrameCount } = get();

    // Check if we have frames - either locally, in backend buffer, or streaming frames
    const hasLocalFrames = framedData.length > 0;
    const hasBackendFrames = framedBufferId !== null && backendFrameCount > 0;
    // Also check for streaming mode where frames go directly to mainFrames
    // (backendFrameCount tracks streaming frames even without framedBufferId)
    const hasStreamingFrames = framedBufferId === null && backendFrameCount > 0;

    if (!hasLocalFrames && !hasBackendFrames && !hasStreamingFrames) return [];

    // Clear serial bytes since they've been processed
    set({
      framingAccepted: true,
      serialBytes: [],
      serialBytesBuffer: [],
    });

    return framedData;
  },

  resetFraming: () => {
    set({
      framingConfig: null,
      framedData: [],
      framingAccepted: false,
      framedBufferId: null,
      backendFrameCount: 0,
      frameIdExtractionConfig: null,
      sourceExtractionConfig: null,
      filteredFrames: [],
      filteredFrameCount: 0,
      filteredBufferId: null,
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

  // Backend buffer actions
  setBackendByteCount: (count) => set({ backendByteCount: count }),

  incrementBackendByteCount: (delta) => set((state) => ({
    backendByteCount: state.backendByteCount + delta,
  })),

  fetchBytesFromBackend: async (offset, limit) => {
    try {
      return await getBufferBytesPaginated(offset, limit);
    } catch (error) {
      tlog.info(`[discoverySerialStore] Failed to fetch bytes from backend: ${error}`);
      return { bytes: [], total_count: 0, offset, limit };
    }
  },

  setRawBytesPageSize: (size) => set({ rawBytesPageSize: size }),

  triggerBufferReady: () => set((state) => ({
    bufferReadyTrigger: state.bufferReadyTrigger + 1,
  })),

  setMinFrameLength: (length) => set({ minFrameLength: length }),

  // Backend frame count actions (for real-time streaming with backend framing)
  incrementBackendFrameCount: (delta) => set((state) => ({
    backendFrameCount: state.backendFrameCount + delta,
  })),

  setBackendFrameCount: (count) => set({ backendFrameCount: count }),
}));
