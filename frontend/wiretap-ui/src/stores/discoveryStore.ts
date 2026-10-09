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

import { useDiscoveryFrameStore, type FrameInfo } from './discoveryFrameStore';
import { useDiscoveryUIStore, type FrameMetadata, type PlaybackSpeed } from './discoveryUIStore';
import { useDiscoverySerialStore } from './discoverySerialStore';
import { useDiscoveryToolboxStore } from './discoveryToolboxStore';
import type { CaptureFrameInfo } from '../api/capture';
import type { FrameMessage } from '../types/frame';
import { groupKeysByProtocol } from '../utils/frameKey';
import type { PageSize } from '../utils/pageSize';
import { selectionSetKeys, type SelectionSet } from '../utils/selectionSets';
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
export { TOOL_TAB_CONFIG } from './discoveryToolboxStore';

// Re-export sub-stores for direct access
export { useDiscoveryFrameStore } from './discoveryFrameStore';
export { useDiscoveryUIStore } from './discoveryUIStore';
export { useDiscoverySerialStore } from './discoverySerialStore';
export { useDiscoveryToolboxStore } from './discoveryToolboxStore';

/** A single byte with its precise timestamp from backend */
export type TimestampedByte = {
  byte: number;
  timestamp_us: number;
  /** Bus/interface number (for multi-source sessions) */
  bus?: number;
};

// Combined state type for backward compatibility
// All Map/Set keys are composite frame keys (e.g. "can:256", "modbus:5013").
type CombinedDiscoveryState = {
  // Frame store
  frameVersion: number;
  frameInfoMap: Map<string, FrameInfo>;
  selectedFrames: Set<string>;
  seenIds: Set<string>;
  streamStartTimeUs: number | null;
  captureMode: { enabled: boolean; totalFrames: number };
  renderFrozen: boolean;

  // UI store
  maxBuffer: number;
  renderBuffer: PageSize;
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
  isSerialMode: boolean;
  framingConfig: import('./discoverySerialStore').FramingConfig | null;
  framedData: FrameMessage[];
  framingAccepted: boolean;
  rawBytesViewConfig: import('./discoverySerialStore').RawBytesViewConfig;
  serialViewConfig: import('./discoverySerialStore').SerialViewConfig;
  serialActiveTab: import('./discoverySerialStore').SerialTabId;
  backendFrameCount: number;
  framedPageSize: PageSize;
  rawBytesPageSize: number;
  framedCaptureId: string | null;
  minFrameLength: number;

  // Toolbox store
  toolbox: import('./discoveryToolboxStore').ToolboxState;
  knowledge: import('../utils/decoderKnowledge').DecoderKnowledge;
  showInfoView: boolean;

  // Combined actions
  setStreamStartTimeUs: (timeUs: number | null) => void;
  clearAll: () => void;
  toggleFrameSelection: (id: string) => void;
  bulkSelectBus: (bus: number | null, select: boolean) => void;
  setMaxBuffer: (value: number) => void;
  setRenderBuffer: (value: PageSize) => void;
  setIoProfile: (profile: string | null) => void;
  setPlaybackSpeed: (speed: PlaybackSpeed) => void;
  updateCurrentTime: (time: number | null) => void;
  setCurrentFrameIndex: (index: number | null) => void;
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
  setRenderFrozen: (frozen: boolean) => void;
  refreshFrozenView: () => void;
  enableCaptureMode: (totalFrames: number) => void;
  disableCaptureMode: () => void;
  setFrameInfoFromCapture: (frameInfoList: CaptureFrameInfo[]) => void;

  // Serial actions
  setSerialMode: (enabled: boolean) => void;
  clearSerialBytes: () => void;
  setFramingConfig: (config: import('./discoverySerialStore').FramingConfig | null) => void;
  applyFraming: () => Promise<FrameMessage[]>;
  acceptFraming: (captureName?: string) => Promise<FrameMessage[]>;
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
  setBackendFrameCount: (count: number) => void;
  incrementBackendFrameCount: (delta: number) => void;
  setFramedPageSize: (size: PageSize) => void;
  setRawBytesPageSize: (size: number) => void;
  setMinFrameLength: (length: number) => void;

  // Toolbox actions
  toggleToolboxExpanded: () => void;
  setActiveView: (view: import('./discoveryToolboxStore').ToolboxView) => void;
  updateMessageOrderOptions: (options: Partial<import('./discoveryToolboxStore').MessageOrderOptions>) => void;
  updateChangesOptions: (options: Partial<import('./discoveryToolboxStore').ChangesOptions>) => void;
  updateChecksumDiscoveryOptions: (options: Partial<import('../api/checksums').ChecksumDiscoveryOptions>) => void;
  openInfoView: () => void;
  closeInfoView: () => void;
  resetKnowledge: () => void;
  clearAnalysisResults: () => void;
  clearToolResult: (toolTabId: string) => void;
  /** `bytesCaptureId` is the session's byte capture — only the Serial Framing tool reads it. */
  runAnalysis: (bytesCaptureId?: string | null) => Promise<void>;
};

/** Every frame of a capture, in 50k pages: the payloads Serial Payload reads. */
async function fetchCaptureFrames(captureId: string): Promise<FrameMessage[]> {
  const { getCaptureFramesPaginatedFiltered, CAPTURE_PAGE_SIZE } = await import('../api/capture');
  const frames: FrameMessage[] = [];
  for (;;) {
    const page = await getCaptureFramesPaginatedFiltered(captureId, frames.length, CAPTURE_PAGE_SIZE, []);
    frames.push(...page.frames);
    if (page.frames.length === 0 || frames.length >= page.total_count) return frames;
  }
}

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
    // Frame store state
    frameVersion: frameStore.frameVersion,
    frameInfoMap: frameStore.frameInfoMap,
    selectedFrames: frameStore.selectedFrames,
    seenIds: frameStore.seenIds,
    streamStartTimeUs: frameStore.streamStartTimeUs,
    captureMode: frameStore.captureMode,
    renderFrozen: frameStore.renderFrozen,

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
    isSerialMode: serialStore.isSerialMode,
    framingConfig: serialStore.framingConfig,
    framedData: serialStore.framedData,
    framingAccepted: serialStore.framingAccepted,
    rawBytesViewConfig: serialStore.rawBytesViewConfig,
    serialViewConfig: serialStore.serialViewConfig,
    serialActiveTab: serialStore.activeTab,
    backendFrameCount: serialStore.backendFrameCount,
    framedPageSize: serialStore.framedPageSize,
    rawBytesPageSize: serialStore.rawBytesPageSize,
    framedCaptureId: serialStore.framedCaptureId,
    minFrameLength: serialStore.minFrameLength,

    // Toolbox store state
    toolbox: toolboxStore.toolbox,
    knowledge: toolboxStore.knowledge,
    showInfoView: toolboxStore.showInfoView,

    // Frame store actions (with coordination)
    setStreamStartTimeUs: frameStore.setStreamStartTimeUs,
    clearAll: frameStore.clearAll,
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
      // Detect protocol from current frameInfoMap, default to 'can'
      let protocol = 'can';
      for (const info of frameStore.frameInfoMap.values()) {
        if (info.protocol) { protocol = info.protocol; break; }
      }
      frameStore.applySelectionSet(selectionSet, protocol, uiStore.setActiveSelectionSet, uiStore.setSelectionSetDirty);
      uiStore.setActiveSelectionSetSelectedIds(
        new Set(selectionSetKeys(selectionSet, protocol).selected)
      );
    },
    setRenderFrozen: frameStore.setRenderFrozen,
    refreshFrozenView: frameStore.refreshFrozenView,
    enableCaptureMode: frameStore.enableCaptureMode,
    disableCaptureMode: frameStore.disableCaptureMode,
    setFrameInfoFromCapture: frameStore.setFrameInfoFromCapture,

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
    clearSerialBytes: serialStore.clearSerialBytes,
    setFramingConfig: serialStore.setFramingConfig,
    applyFraming: () => serialStore.applyFraming(frameStore.streamStartTimeUs, uiStore.ioProfile ?? undefined),
    acceptFraming: async (captureName?: string) => {
      // Read the framing result before acceptFraming resets it.
      const { framedCaptureId, backendFrameCount } = serialStore;
      const hasBackendFrames = framedCaptureId !== null && backendFrameCount > 0;
      // Streaming mode: frames go directly to mainFrames (framedCaptureId is null)
      const hasStreamingFrames = framedCaptureId === null && backendFrameCount > 0;

      const frames = serialStore.acceptFraming();
      const { getCaptureFrameInfo } = await import('../api/capture');

      if (hasBackendFrames) {
        // Backend framing mode: frames are stored in backend buffer
        // Load frame info from the backend buffer for the frame picker
        try {
          const frameInfoList = await getCaptureFrameInfo(framedCaptureId);
          frameStore.setFrameInfoFromCapture(frameInfoList);
          frameStore.enableCaptureMode(backendFrameCount);
          tlog.debug(`[discoveryStore] Loaded ${frameInfoList.length} unique frame IDs from backend buffer`);
        } catch (e) {
          tlog.info(`[discoveryStore] Failed to load frame info from backend buffer: ${e}`);
        }
      } else if (hasStreamingFrames) {
        // A reader that frames on the wire wrote them into the session's own capture.
        const { useSessionStore } = await import('./sessionStore');
        const sessionCaptureId = useSessionStore.getState().sessions[uiStore.ioProfile ?? '']?.capture?.id;
        if (sessionCaptureId) {
          frameStore.setFrameInfoFromCapture(await getCaptureFrameInfo(sessionCaptureId));
        }
      } else if (frames.length > 0) {
        const { createFrameCaptureFromFrames } = await import('../api/capture');
        const name = captureName || `Framed Serial ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
        const completeFrames = frames.filter(f => !f.incomplete);
        if (completeFrames.length > 0) {
          try {
            const capture = await createFrameCaptureFromFrames(uiStore.ioProfile ?? '', name, completeFrames);
            frameStore.setFrameInfoFromCapture(await getCaptureFrameInfo(capture.id));
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
    setBackendFrameCount: serialStore.setBackendFrameCount,
    incrementBackendFrameCount: serialStore.incrementBackendFrameCount,
    setFramedPageSize: serialStore.setFramedPageSize,
    setRawBytesPageSize: serialStore.setRawBytesPageSize,
    setMinFrameLength: serialStore.setMinFrameLength,

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
    clearToolResult: toolboxStore.clearToolResult,

    // Combined runAnalysis that coordinates between stores
    runAnalysis: async (bytesCaptureId) => {
      const { toolbox } = toolboxStore;
      const { selectedFrames, captureMode, frameInfoMap } = frameStore;
      const { isSerialMode } = serialStore;
      const { useSessionStore } = await import('./sessionStore');
      const sessionCaptureId =
        useSessionStore.getState().sessions[uiStore.ioProfile ?? '']?.capture?.id ?? null;
      // Framing applied on the client is held here; a reader that frames on the wire
      // wrote into the session's capture.
      const serialCaptureId = serialStore.framedCaptureId ?? sessionCaptureId;

      if (toolbox.activeView === 'serial-framing') {
        if (!bytesCaptureId) return;
        toolboxStore.setSerialPayloadResults(null);
        // Scored against whatever this session is framing with, its catalogue
        // included, so what the tool reports is what the framer would actually do.
        await toolboxStore.runSerialFramingAnalysis(bytesCaptureId, {
          device_address: serialStore.framingConfig?.deviceAddress,
          validate_crc: serialStore.framingConfig?.validateCrc,
          vendor_functions: serialStore.framingConfig?.vendorFunctions,
          allow_broadcast: serialStore.framingConfig?.allowBroadcast,
          any_function: serialStore.framingConfig?.anyFunction,
        }, uiStore.ioProfile ?? undefined);
        return;
      }

      if (toolbox.activeView === 'serial-payload') {
        toolboxStore.setSerialFramingResults(null);
        if (!serialCaptureId) return;
        toolboxStore.setIsRunning(true);
        let payloadFrames: FrameMessage[] = [];
        try {
          payloadFrames = await fetchCaptureFrames(serialCaptureId);
        } catch (e) {
          tlog.info(`[discoveryStore] Failed to fetch frames from backend buffer: ${e}`);
        }
        if (payloadFrames.length === 0) {
          toolboxStore.setIsRunning(false);
          return;
        }
        await toolboxStore.runSerialPayloadAnalysis(payloadFrames);
        return;
      }

      // When the Filtered tab is active, analyse filtered-out IDs instead of selected ones
      const { framesViewActiveTab } = useDiscoveryUIStore.getState();
      const targetKeys = framesViewActiveTab === 'filtered'
        ? new Set([...frameStore.seenIds].filter((fk) => !selectedFrames.has(fk)))
        : selectedFrames;
      // Serial has never filtered by selection: its frames live in a capture of
      // their own, and an empty selection reads all of it.
      const selection = isSerialMode ? [] : groupKeysByProtocol(targetKeys);
      const captureId = isSerialMode ? serialCaptureId : sessionCaptureId;
      // Empty means "nothing selected" here and "every frame" to the backend.
      if (!captureId || (!isSerialMode && selection.length === 0)) return;

      // A live session analyses its most recent history; a stopped capture, all of it.
      const newest = captureMode.enabled ? undefined : uiStore.maxBuffer;
      switch (toolbox.activeView) {
        case 'checksum-discovery':
          await toolboxStore.runChecksumDiscoveryAnalysis({ captureId, selection });
          break;
        case 'message-order':
          await toolboxStore.runMessageOrderAnalysis({ captureId, selection, newest }, frameInfoMap);
          break;
        case 'changes':
          await toolboxStore.runChangesAnalysis({ captureId, selection, newest }, frameInfoMap);
          break;
      }
    },
  };

  return selector(combinedState);
}
