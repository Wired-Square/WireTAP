// ui/src/stores/discoveryStore.ts
//
// Re-export layer that combines all discovery sub-stores.
// Provides backward compatibility - existing imports continue to work.
//
// Sub-stores:
// - discoveryFrameStore.ts - frame data, selection, buffer mode
// - discoveryUIStore.ts - UI state, dialogs, playback, time range
// - discoverySerialStore.ts - serial bytes, framing
// - discoveryToolboxStore.ts - analysis tools, knowledge

import { useDiscoveryFrameStore, getDiscoveryFrameBuffer, type FrameInfo } from './discoveryFrameStore';
import { useDiscoveryUIStore, type FrameMetadata, type PlaybackSpeed } from './discoveryUIStore';
import { useDiscoverySerialStore } from './discoverySerialStore';
import { useDiscoveryToolboxStore } from './discoveryToolboxStore';
import type { FrameMessage } from '../types/frame';
import type { SelectionSet } from '../utils/selectionSets';
import { tlog } from '../api/settings';

// Re-export types for backward compatibility
export type { FrameMessage } from '../types/frame';
export type { FrameInfo } from './discoveryFrameStore';
export type { FrameMetadata, PlaybackSpeed } from './discoveryUIStore';
export type {
  SerialBytesEntry,
  FramingConfig,
  RawBytesDisplayMode,
  RawBytesViewConfig,
  SerialViewConfig,
  ByteExtractionConfig,
  SerialTabId,
} from './discoverySerialStore';
export type {
  ToolboxView,
  MessageOrderOptions,
  ChangesOptions,
  ChangesResult,
  SerialFramingResult,
  SerialPayloadResult,
  ToolboxState,
} from './discoveryToolboxStore';

// Re-export sub-stores for direct access
export { useDiscoveryFrameStore, getDiscoveryFrameBuffer } from './discoveryFrameStore';
export { useDiscoveryUIStore } from './discoveryUIStore';
export { useDiscoverySerialStore } from './discoverySerialStore';
export { useDiscoveryToolboxStore } from './discoveryToolboxStore';

/** Raw serial bytes event payload from backend - batched for performance */
export type SerialRawBytesPayload = {
  bytes: Array<{ byte: number; timestamp_us: number; bus?: number }>;
  port: string;
};

/** A single byte with its precise timestamp from backend */
export type TimestampedByte = {
  byte: number;
  timestamp_us: number;
  /** Bus/interface number (for multi-source sessions) */
  bus?: number;
};

// Combined state type for backward compatibility
type CombinedDiscoveryState = {
  // Frame store (frames is from mutable buffer, use frameVersion for reactivity)
  frames: FrameMessage[];
  frameVersion: number;
  frameInfoMap: Map<number, FrameInfo>;
  selectedFrames: Set<number>;
  seenIds: Set<number>;
  streamStartTimeUs: number | null;
  bufferMode: { enabled: boolean; totalFrames: number };

  // UI store
  maxBuffer: number;
  renderBuffer: number;
  ioProfile: string | null;
  playbackSpeed: PlaybackSpeed;
  currentTime: number | null;
  currentFrameIndex: number | null;
  startTime: string;
  endTime: string;
  showSaveDialog: boolean;
  saveMetadata: FrameMetadata;
  serialConfig: import('../utils/frameExport').SerialFrameConfig | null;
  activeSelectionSetId: string | null;
  selectionSetDirty: boolean;

  // Serial store
  serialBytes: import('./discoverySerialStore').SerialBytesEntry[];
  serialBytesBuffer: number[];
  isSerialMode: boolean;
  framingConfig: import('./discoverySerialStore').FramingConfig | null;
  framedData: FrameMessage[];
  framingAccepted: boolean;
  rawBytesViewConfig: import('./discoverySerialStore').RawBytesViewConfig;
  serialViewConfig: import('./discoverySerialStore').SerialViewConfig;
  serialActiveTab: import('./discoverySerialStore').SerialTabId;
  backendByteCount: number;
  backendFrameCount: number;
  framedPageSize: number;
  rawBytesPageSize: number;
  framedBufferId: string | null;
  minFrameLength: number;

  // Toolbox store
  toolbox: import('./discoveryToolboxStore').ToolboxState;
  knowledge: import('../utils/decoderKnowledge').DecoderKnowledge;
  showInfoView: boolean;

  // Combined actions
  setStreamStartTimeUs: (timeUs: number | null) => void;
  addFrames: (newFrames: FrameMessage[], skipFramePicker?: boolean) => void;
  clearBuffer: () => void;
  clearFramePicker: () => void;
  clearAll: () => void;
  toggleFrameSelection: (id: number) => void;
  bulkSelectBus: (bus: number | null, select: boolean) => void;
  setMaxBuffer: (value: number) => void;
  setRenderBuffer: (value: number) => void;
  setIoProfile: (profile: string | null) => void;
  setPlaybackSpeed: (speed: PlaybackSpeed) => void;
  updateCurrentTime: (time: number | null) => void;
  setCurrentFrameIndex: (index: number | null) => void;
  rebuildFramePickerFromBuffer: () => void;
  setStartTime: (time: string) => void;
  setEndTime: (time: string) => void;
  openSaveDialog: () => void;
  closeSaveDialog: () => void;
  updateSaveMetadata: (metadata: FrameMetadata) => void;
  setSerialConfig: (config: import('../utils/frameExport').SerialFrameConfig | null) => void;
  saveFrames: (decoderDir: string, saveFrameIdFormat: 'hex' | 'decimal') => Promise<void>;
  setActiveSelectionSet: (id: string | null) => void;
  setSelectionSetDirty: (dirty: boolean) => void;
  applySelectionSet: (selectionSet: SelectionSet) => void;
  selectAllFrames: () => void;
  deselectAllFrames: () => void;
  enableBufferMode: (totalFrames: number) => void;
  disableBufferMode: () => void;
  setFrameInfoFromBuffer: (frameInfoList: Array<{
    frame_id: number;
    max_dlc: number;
    bus: number;
    is_extended: boolean;
    has_dlc_mismatch: boolean;
  }>, protocol?: string) => void;
  setFrames: (frames: FrameMessage[]) => void;

  // Serial actions
  setSerialMode: (enabled: boolean) => void;
  addSerialBytes: (entries: import('./discoverySerialStore').SerialBytesEntry[]) => void;
  clearSerialBytes: (preserveBackendCount?: boolean) => void;
  setFramingConfig: (config: import('./discoverySerialStore').FramingConfig | null) => void;
  applyFraming: () => Promise<FrameMessage[]>;
  acceptFraming: (bufferName?: string) => Promise<FrameMessage[]>;
  resetFraming: () => void;
  undoAcceptFraming: () => void;
  applyFrameIdMapping: (config: import('./discoverySerialStore').ByteExtractionConfig) => void;
  clearFrameIdMapping: () => void;
  applySourceMapping: (config: import('./discoverySerialStore').ByteExtractionConfig) => void;
  clearSourceMapping: () => void;
  setRawBytesViewConfig: (config: import('./discoverySerialStore').RawBytesViewConfig) => void;
  setSerialViewConfig: (config: import('./discoverySerialStore').SerialViewConfig) => void;
  toggleShowAscii: () => void;
  setSerialActiveTab: (tab: import('./discoverySerialStore').SerialTabId) => void;
  setBackendByteCount: (count: number) => void;
  incrementBackendByteCount: (delta: number) => void;
  setBackendFrameCount: (count: number) => void;
  incrementBackendFrameCount: (delta: number) => void;
  setFramedPageSize: (size: number) => void;
  setRawBytesPageSize: (size: number) => void;
  setMinFrameLength: (length: number) => void;
  triggerBufferReady: () => void;

  // Toolbox actions
  toggleToolboxExpanded: () => void;
  setActiveView: (view: import('./discoveryToolboxStore').ToolboxView) => void;
  updateMessageOrderOptions: (options: Partial<import('./discoveryToolboxStore').MessageOrderOptions>) => void;
  updateChangesOptions: (options: Partial<import('./discoveryToolboxStore').ChangesOptions>) => void;
  updateChecksumDiscoveryOptions: (options: Partial<import('../utils/analysis/checksumDiscovery').ChecksumDiscoveryOptions>) => void;
  openInfoView: () => void;
  closeInfoView: () => void;
  resetKnowledge: () => void;
  clearAnalysisResults: () => void;
  runAnalysis: () => Promise<void>;
};

/**
 * Combined discovery store hook for backward compatibility.
 * Subscribes to all sub-stores and presents a unified interface.
 *
 * For better performance in new code, use the individual sub-stores directly:
 * - useDiscoveryFrameStore for frame data
 * - useDiscoveryUIStore for UI state
 * - useDiscoverySerialStore for serial data
 * - useDiscoveryToolboxStore for analysis
 */
export function useDiscoveryStore<T>(selector: (state: CombinedDiscoveryState) => T): T {
  // Subscribe to all sub-stores
  const frameStore = useDiscoveryFrameStore();
  const uiStore = useDiscoveryUIStore();
  const serialStore = useDiscoverySerialStore();
  const toolboxStore = useDiscoveryToolboxStore();

  // Create wrapper actions that coordinate between stores
  const combinedState: CombinedDiscoveryState = {
    // Frame store state (frames is from mutable buffer, frameVersion triggers re-renders)
    frames: getDiscoveryFrameBuffer(),
    frameVersion: frameStore.frameVersion,
    frameInfoMap: frameStore.frameInfoMap,
    selectedFrames: frameStore.selectedFrames,
    seenIds: frameStore.seenIds,
    streamStartTimeUs: frameStore.streamStartTimeUs,
    bufferMode: frameStore.bufferMode,

    // UI store state
    maxBuffer: uiStore.maxBuffer,
    renderBuffer: uiStore.renderBuffer,
    ioProfile: uiStore.ioProfile,
    playbackSpeed: uiStore.playbackSpeed,
    currentTime: uiStore.currentTime,
    currentFrameIndex: uiStore.currentFrameIndex,
    startTime: uiStore.startTime,
    endTime: uiStore.endTime,
    showSaveDialog: uiStore.showSaveDialog,
    saveMetadata: uiStore.saveMetadata,
    serialConfig: uiStore.serialConfig,
    activeSelectionSetId: uiStore.activeSelectionSetId,
    selectionSetDirty: uiStore.selectionSetDirty,

    // Serial store state
    serialBytes: serialStore.serialBytes,
    serialBytesBuffer: serialStore.serialBytesBuffer,
    isSerialMode: serialStore.isSerialMode,
    framingConfig: serialStore.framingConfig,
    framedData: serialStore.framedData,
    framingAccepted: serialStore.framingAccepted,
    rawBytesViewConfig: serialStore.rawBytesViewConfig,
    serialViewConfig: serialStore.serialViewConfig,
    serialActiveTab: serialStore.activeTab,
    backendByteCount: serialStore.backendByteCount,
    backendFrameCount: serialStore.backendFrameCount,
    framedPageSize: serialStore.framedPageSize,
    rawBytesPageSize: serialStore.rawBytesPageSize,
    framedBufferId: serialStore.framedBufferId,
    minFrameLength: serialStore.minFrameLength,

    // Toolbox store state
    toolbox: toolboxStore.toolbox,
    knowledge: toolboxStore.knowledge,
    showInfoView: toolboxStore.showInfoView,

    // Frame store actions (with coordination)
    setStreamStartTimeUs: frameStore.setStreamStartTimeUs,
    addFrames: (newFrames, skipFramePicker) => {
      frameStore.addFrames(newFrames, uiStore.maxBuffer, skipFramePicker, uiStore.activeSelectionSetSelectedIds);
    },
    clearBuffer: frameStore.clearBuffer,
    clearFramePicker: frameStore.clearFramePicker,
    clearAll: frameStore.clearAll,
    setFrames: frameStore.setFrames,
    rebuildFramePickerFromBuffer: frameStore.rebuildFramePickerFromBuffer,
    toggleFrameSelection: (id) => {
      frameStore.toggleFrameSelection(id, uiStore.activeSelectionSetId, uiStore.setSelectionSetDirty);
    },
    bulkSelectBus: (bus, select) => {
      frameStore.bulkSelectBus(bus, select, uiStore.activeSelectionSetId, uiStore.setSelectionSetDirty);
    },
    selectAllFrames: () => {
      frameStore.selectAllFrames(uiStore.activeSelectionSetId, uiStore.setSelectionSetDirty);
    },
    deselectAllFrames: () => {
      frameStore.deselectAllFrames(uiStore.activeSelectionSetId, uiStore.setSelectionSetDirty);
    },
    applySelectionSet: (selectionSet) => {
      frameStore.applySelectionSet(selectionSet, uiStore.setActiveSelectionSet, uiStore.setSelectionSetDirty);
      uiStore.setActiveSelectionSetSelectedIds(
        new Set(selectionSet.selectedIds ?? selectionSet.frameIds)
      );
    },
    enableBufferMode: frameStore.enableBufferMode,
    disableBufferMode: frameStore.disableBufferMode,
    setFrameInfoFromBuffer: frameStore.setFrameInfoFromBuffer,

    // UI store actions
    setMaxBuffer: uiStore.setMaxBuffer,
    setRenderBuffer: uiStore.setRenderBuffer,
    setIoProfile: uiStore.setIoProfile,
    setPlaybackSpeed: uiStore.setPlaybackSpeed,
    updateCurrentTime: uiStore.updateCurrentTime,
    setCurrentFrameIndex: uiStore.setCurrentFrameIndex,
    setStartTime: uiStore.setStartTime,
    setEndTime: uiStore.setEndTime,
    openSaveDialog: () => {
      // Generate dynamic filename based on date/time and protocol
      const now = new Date();
      const dateStr = now.toISOString().slice(0, 10).replace(/-/g, '');
      const timeStr = now.toTimeString().slice(0, 5).replace(':', '');

      // Detect protocol from frameInfoMap
      let protocol = 'can';
      for (const info of frameStore.frameInfoMap.values()) {
        if (info.protocol) {
          protocol = info.protocol;
          break;
        }
      }
      // Fall back to frames if no protocol in frameInfoMap
      const frameBuffer = getDiscoveryFrameBuffer();
      if (protocol === 'can' && frameBuffer.length > 0) {
        protocol = frameBuffer[0].protocol || 'can';
      }
      // Check serial mode
      if (serialStore.isSerialMode) {
        protocol = 'serial';
      }

      const filename = `${dateStr}-${timeStr}-${protocol}.toml`;
      uiStore.updateSaveMetadata({ ...uiStore.saveMetadata, filename });
      uiStore.openSaveDialog();
    },
    closeSaveDialog: uiStore.closeSaveDialog,
    updateSaveMetadata: uiStore.updateSaveMetadata,
    setSerialConfig: uiStore.setSerialConfig,
    saveFrames: (decoderDir, saveFrameIdFormat) => {
      return uiStore.saveFrames(decoderDir, saveFrameIdFormat, frameStore.selectedFrames, frameStore.frameInfoMap);
    },
    setActiveSelectionSet: (id: string | null) => {
      uiStore.setActiveSelectionSet(id);
      if (id === null) {
        uiStore.setActiveSelectionSetSelectedIds(null);
      }
    },
    setSelectionSetDirty: uiStore.setSelectionSetDirty,

    // Serial store actions
    setSerialMode: serialStore.setSerialMode,
    addSerialBytes: serialStore.addSerialBytes,
    clearSerialBytes: serialStore.clearSerialBytes,
    setFramingConfig: serialStore.setFramingConfig,
    applyFraming: () => serialStore.applyFraming(frameStore.streamStartTimeUs),
    acceptFraming: async (bufferName?: string) => {
      // Get backend buffer info BEFORE calling acceptFraming (which clears serialBytes)
      const { framedBufferId, backendFrameCount } = serialStore;
      const hasBackendFrames = framedBufferId !== null && backendFrameCount > 0;
      // Streaming mode: frames go directly to mainFrames (framedBufferId is null)
      const hasStreamingFrames = framedBufferId === null && backendFrameCount > 0;

      const frames = serialStore.acceptFraming();

      if (hasBackendFrames) {
        // Backend framing mode: frames are stored in backend buffer
        // Load frame info from the backend buffer for the frame picker
        try {
          const { getBufferFrameInfo } = await import('../api/buffer');
          const frameInfoList = await getBufferFrameInfo();
          // Pass 'serial' protocol since this is from serial framing
          frameStore.setFrameInfoFromBuffer(frameInfoList, 'serial');
          frameStore.enableBufferMode(backendFrameCount);
          tlog.debug(`[discoveryStore] Loaded ${frameInfoList.length} unique frame IDs from backend buffer`);
        } catch (e) {
          tlog.info(`[discoveryStore] Failed to load frame info from backend buffer: ${e}`);
        }
      } else if (hasStreamingFrames) {
        // Streaming mode: frames are already in mainFrames, just need to update frame info
        // Frames were added via addFrames() during streaming
        const mainFrames = getDiscoveryFrameBuffer();
        if (mainFrames.length > 0) {
          // Apply extraction configs to update frame IDs/source addresses in the actual frames
          const { frameIdExtractionConfig, sourceExtractionConfig } = serialStore;
          if (frameIdExtractionConfig || sourceExtractionConfig) {
            const updatedFrames = mainFrames.map(frame => {
              const newFrame = { ...frame };

              // Apply ID extraction if configured
              if (frameIdExtractionConfig) {
                const { startByte, numBytes, endianness } = frameIdExtractionConfig;
                const resolvedStart = startByte >= 0 ? startByte : Math.max(0, frame.bytes.length + startByte);
                if (resolvedStart < frame.bytes.length) {
                  let frameId = 0;
                  const endByte = Math.min(resolvedStart + numBytes, frame.bytes.length);
                  if (endianness === 'big') {
                    for (let i = resolvedStart; i < endByte; i++) {
                      frameId = (frameId << 8) | frame.bytes[i];
                    }
                  } else {
                    for (let i = resolvedStart; i < endByte; i++) {
                      frameId |= frame.bytes[i] << (8 * (i - resolvedStart));
                    }
                  }
                  newFrame.frame_id = frameId;
                }
              }

              // Apply source extraction if configured
              if (sourceExtractionConfig) {
                const { startByte, numBytes, endianness } = sourceExtractionConfig;
                const resolvedStart = startByte >= 0 ? startByte : Math.max(0, frame.bytes.length + startByte);
                if (resolvedStart < frame.bytes.length) {
                  let source = 0;
                  const endByte = Math.min(resolvedStart + numBytes, frame.bytes.length);
                  if (endianness === 'big') {
                    for (let i = resolvedStart; i < endByte; i++) {
                      source = (source << 8) | frame.bytes[i];
                    }
                  } else {
                    for (let i = resolvedStart; i < endByte; i++) {
                      source |= frame.bytes[i] << (8 * (i - resolvedStart));
                    }
                  }
                  newFrame.source_address = source;
                }
              }

              return newFrame;
            });

            // Replace frames in store with updated ones
            frameStore.setFrames(updatedFrames);
            tlog.debug(`[discoveryStore] Applied extraction configs to ${updatedFrames.length} streaming frames`);
          } else {
            // No extraction configs, just rebuild frame picker
            frameStore.rebuildFramePickerFromBuffer();
          }
          tlog.debug(`[discoveryStore] Accepted ${mainFrames.length} streaming frames`);
        }
      } else if (frames.length > 0) {
        // Local framing mode: frames are in memory
        frameStore.setFrames(frames);
        // Create a frame buffer from the accepted framing
        const { createFrameBufferFromFrames } = await import('../api/buffer');
        const name = bufferName || `Framed Serial ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
        // Filter out incomplete frames before storing
        const completeFrames = frames.filter(f => !f.incomplete);
        if (completeFrames.length > 0) {
          try {
            await createFrameBufferFromFrames(name, completeFrames);
          } catch (e) {
            tlog.info(`[discoveryStore] Failed to create frame buffer: ${e}`);
          }
        }
      }
      return frames;
    },
    resetFraming: serialStore.resetFraming,
    undoAcceptFraming: serialStore.undoAcceptFraming,
    applyFrameIdMapping: serialStore.applyFrameIdMapping,
    clearFrameIdMapping: serialStore.clearFrameIdMapping,
    applySourceMapping: serialStore.applySourceMapping,
    clearSourceMapping: serialStore.clearSourceMapping,
    setRawBytesViewConfig: serialStore.setRawBytesViewConfig,
    setSerialViewConfig: serialStore.setSerialViewConfig,
    toggleShowAscii: serialStore.toggleShowAscii,
    setSerialActiveTab: serialStore.setActiveTab,
    setBackendByteCount: serialStore.setBackendByteCount,
    incrementBackendByteCount: serialStore.incrementBackendByteCount,
    setBackendFrameCount: serialStore.setBackendFrameCount,
    incrementBackendFrameCount: serialStore.incrementBackendFrameCount,
    setFramedPageSize: serialStore.setFramedPageSize,
    setRawBytesPageSize: serialStore.setRawBytesPageSize,
    setMinFrameLength: serialStore.setMinFrameLength,
    triggerBufferReady: serialStore.triggerBufferReady,

    // Toolbox store actions
    toggleToolboxExpanded: toolboxStore.toggleToolboxExpanded,
    setActiveView: toolboxStore.setActiveView,
    updateMessageOrderOptions: toolboxStore.updateMessageOrderOptions,
    updateChangesOptions: toolboxStore.updateChangesOptions,
    updateChecksumDiscoveryOptions: toolboxStore.updateChecksumDiscoveryOptions,
    openInfoView: () => toolboxStore.openInfoView(frameStore.frameInfoMap),
    closeInfoView: toolboxStore.closeInfoView,
    resetKnowledge: toolboxStore.resetKnowledge,
    clearAnalysisResults: toolboxStore.clearAnalysisResults,

    // Combined runAnalysis that coordinates between stores
    runAnalysis: async () => {
      const { toolbox } = toolboxStore;
      const { selectedFrames, bufferMode, frameInfoMap } = frameStore;
      const frames = getDiscoveryFrameBuffer();
      const { framedData, serialBytesBuffer, isSerialMode } = serialStore;

      // Handle serial framing analysis separately - only needs raw bytes
      if (toolbox.activeView === 'serial-framing') {
        if (serialBytesBuffer.length === 0) return;
        // Clear payload results so framing results are shown
        toolboxStore.setSerialPayloadResults(null);
        await toolboxStore.runSerialFramingAnalysis(serialBytesBuffer);
        return;
      }

      // Handle serial payload analysis - needs framed data
      if (toolbox.activeView === 'serial-payload') {
        // Clear framing results so payload results are shown
        toolboxStore.setSerialFramingResults(null);
        let serialFrames: FrameMessage[] = framedData.length > 0 ? framedData : frames;

        // If no local frames but backend buffer exists, fetch from backend
        if (serialFrames.length === 0 && serialStore.framedBufferId && serialStore.backendFrameCount > 0) {
          toolboxStore.setIsRunning(true);
          try {
            const { getBufferFramesPaginatedById } = await import('../api/buffer');
            const BATCH_SIZE = 50000;
            serialFrames = [];
            let offset = 0;
            const totalCount = serialStore.backendFrameCount;

            while (offset < totalCount) {
              const response = await getBufferFramesPaginatedById(
                serialStore.framedBufferId,
                offset,
                BATCH_SIZE
              );
              serialFrames.push(...(response.frames as FrameMessage[]));
              offset += response.frames.length;
              if (response.frames.length === 0) break; // Safety check
            }
          } catch (e) {
            tlog.info(`[discoveryStore] Failed to fetch frames from backend buffer: ${e}`);
            toolboxStore.setIsRunning(false);
            return;
          }
        }

        if (serialFrames.length === 0) return;
        await toolboxStore.runSerialPayloadAnalysis(serialFrames);
        return;
      }

      // For CAN analysis tools, get selected frame data
      let selectedFrameData: FrameMessage[];

      if (isSerialMode) {
        selectedFrameData = framedData.length > 0 ? framedData : frames;
        if (selectedFrameData.length === 0) return;
      } else if (bufferMode.enabled) {
        const { getBufferFramesPaginatedFiltered } = await import('../api/buffer');
        const selectedIds = Array.from(selectedFrames);
        if (selectedIds.length === 0) return;

        toolboxStore.setIsRunning(true);
        await new Promise(resolve => setTimeout(resolve, 50));

        const BATCH_SIZE = 50000;
        selectedFrameData = [];
        let offset = 0;

        try {
          const firstResponse = await getBufferFramesPaginatedFiltered(0, BATCH_SIZE, selectedIds);
          const totalCount = firstResponse.total_count;
          selectedFrameData.push(...(firstResponse.frames as FrameMessage[]));
          offset = firstResponse.frames.length;

          while (offset < totalCount) {
            const response = await getBufferFramesPaginatedFiltered(offset, BATCH_SIZE, selectedIds);
            selectedFrameData.push(...(response.frames as FrameMessage[]));
            offset += response.frames.length;
          }
        } catch (e) {
          tlog.info(`[discoveryStore] Failed to fetch frames from buffer: ${e}`);
          toolboxStore.setIsRunning(false);
          return;
        }
      } else {
        selectedFrameData = frames.filter((f) => selectedFrames.has(f.frame_id));
        if (selectedFrameData.length === 0) return;
      }

      switch (toolbox.activeView) {
        case 'message-order':
          await toolboxStore.runMessageOrderAnalysis(selectedFrameData, frameInfoMap);
          break;
        case 'changes':
          await toolboxStore.runChangesAnalysis(selectedFrameData, frameInfoMap);
          break;
        case 'checksum-discovery':
          await toolboxStore.runChecksumDiscoveryAnalysis(selectedFrameData);
          break;
      }
    },
  };

  return selector(combinedState);
}
