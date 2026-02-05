// ui/src/apps/discovery/hooks/useDiscoveryHandlers.ts
//
// Orchestrator hook that composes all Discovery domain handlers.

import { useCallback } from "react";
import {
  useDiscoverySessionHandlers,
  type DiscoverySessionHandlers,
} from "./handlers/useDiscoverySessionHandlers";
import {
  useDiscoveryPlaybackHandlers,
  type DiscoveryPlaybackHandlers,
} from "./handlers/useDiscoveryPlaybackHandlers";
import {
  useDiscoveryExportHandlers,
  type DiscoveryExportHandlers,
} from "./handlers/useDiscoveryExportHandlers";
import {
  useDiscoveryBookmarkHandlers,
  type DiscoveryBookmarkHandlers,
} from "./handlers/useDiscoveryBookmarkHandlers";
import {
  useDiscoverySelectionHandlers,
  type DiscoverySelectionHandlers,
} from "./handlers/useDiscoverySelectionHandlers";
import type { PlaybackSpeed, FrameMessage } from "../../../stores/discoveryStore";
import type { BufferMetadata, TimestampedByte } from "../../../api/buffer";
import type { ExportDataMode } from "../../../dialogs/ExportFramesDialog";
import type { SelectionSet } from "../../../utils/selectionSets";
import { isBufferProfileId, type IngestOptions as ManagerIngestOptions } from "../../../hooks/useIOSessionManager";
import type { TimeRangeFavorite } from "../../../utils/favorites";

export interface UseDiscoveryHandlersParams {
  // Session state
  sessionId: string;
  multiBusMode: boolean;
  isStreaming: boolean;
  isPaused: boolean;
  sessionReady: boolean;
  ioProfile: string | null;
  sourceProfileId: string | null;
  playbackSpeed: PlaybackSpeed;
  /** Buffer mode from session manager - used for play/resume logic */
  sessionIsBufferMode: boolean;
  /** Buffer mode from discovery store - used for UI display */
  bufferModeEnabled: boolean;
  bufferModeTotalFrames: number;

  // Frame state
  frames: FrameMessage[];
  framedData: FrameMessage[];
  framedBufferId: string | null;
  frameInfoMap: Map<number, any>;
  selectedFrames: Set<number>;

  // Serial state
  isSerialMode: boolean;
  backendByteCount: number;
  backendFrameCount: number;
  serialBytesBufferLength: number;

  // Time state
  startTime: string;
  endTime: string;
  currentFrameIndex?: number | null;
  currentTimestampUs?: number | null;

  // Selection set state
  activeSelectionSetId: string | null;
  selectionSetDirty: boolean;

  // Export state
  exportDataMode: ExportDataMode;
  decoderDir: string;
  saveFrameIdFormat: 'hex' | 'decimal';
  dumpDir: string;

  // Local state
  pendingSpeed: PlaybackSpeed | null;
  setPendingSpeed: (speed: PlaybackSpeed | null) => void;
  setActiveBookmarkId: (id: string | null) => void;
  setBookmarkFrameId: (id: number) => void;
  setBookmarkFrameTime: (time: string) => void;
  resetWatchFrameCount: () => void;
  setBufferMetadata: (meta: BufferMetadata | null) => void;

  // Manager session switching methods
  watchSingleSource: (profileId: string, options: ManagerIngestOptions, reinitializeOptions?: Record<string, unknown>) => Promise<void>;
  watchMultiSource: (profileIds: string[], options: ManagerIngestOptions) => Promise<void>;
  ingestSingleSource: (profileId: string, options: ManagerIngestOptions) => Promise<void>;
  ingestMultiSource: (profileIds: string[], options: ManagerIngestOptions) => Promise<void>;
  stopWatch: () => Promise<void>;
  selectProfile: (profileId: string | null) => void;
  selectMultipleProfiles: (profileIds: string[]) => void;
  joinSession: (sessionId: string, sourceProfileIds?: string[]) => Promise<void>;
  jumpToBookmark: (bookmark: TimeRangeFavorite, options?: Omit<ManagerIngestOptions, "startTime" | "endTime" | "maxFrames">) => Promise<void>;

  // Session actions
  setIoProfile: (profileId: string | null) => void;
  setSourceProfileId: (profileId: string | null) => void;
  setShowBusColumn: (show: boolean) => void;
  start: () => Promise<void>;
  pause: () => Promise<void>;
  resume: () => Promise<void>;
  reinitialize: (profileId?: string, options?: any) => Promise<void>;
  setSpeed: (speed: number) => Promise<void>;
  setTimeRange: (start: string, end: string) => Promise<void>;
  seekByFrame: (frameIndex: number) => Promise<void>;

  // Store actions
  setPlaybackSpeed: (speed: PlaybackSpeed) => void;
  updateCurrentTime: (time: number) => void;
  setCurrentFrameIndex: (index: number) => void;
  setMaxBuffer: (count: number) => void;
  setStartTime: (time: string) => void;
  setEndTime: (time: string) => void;
  clearBuffer: () => void;
  clearFramePicker: () => void;
  clearAnalysisResults: () => void;
  enableBufferMode: (count: number) => void;
  disableBufferMode: () => void;
  setFrameInfoFromBuffer: (frameInfo: any[]) => void;
  clearSerialBytes: (preserveCount?: boolean) => void;
  resetFraming: () => void;
  setBackendByteCount: (count: number) => void;
  setBackendFrameCount: (count: number) => void;
  addSerialBytes: (entries: { byte: number; timestampUs: number }[]) => void;
  setSerialConfig: (config: any) => void;
  setFramingConfig: (config: any) => void;
  showError: (title: string, message: string, details?: string) => void;
  openSaveDialog: () => void;
  saveFrames: (decoderDir: string, format: 'hex' | 'decimal') => Promise<void>;
  setActiveSelectionSet: (id: string | null) => void;
  setSelectionSetDirty: (dirty: boolean) => void;
  applySelectionSet: (set: SelectionSet) => void;

  // API functions (for export/other features)
  getBufferBytesPaginated: (offset: number, limit: number) => Promise<{ bytes: TimestampedByte[] }>;
  getBufferFramesPaginated: (offset: number, limit: number) => Promise<{ frames: any[] }>;
  getBufferFramesPaginatedById: (id: string, offset: number, limit: number) => Promise<{ frames: any[] }>;
  clearBackendBuffer: () => Promise<void>;
  pickFileToSave: (options: any) => Promise<string | null>;
  saveCatalog: (path: string, content: string) => Promise<void>;

  // Dialog controls
  openBookmarkDialog: () => void;
  closeSpeedChangeDialog: () => void;
  openSaveSelectionSetDialog: () => void;
  closeExportDialog: () => void;
  closeIoReaderPicker: () => void;
}

export type DiscoveryHandlers = DiscoverySessionHandlers &
  DiscoveryPlaybackHandlers &
  DiscoveryExportHandlers &
  DiscoveryBookmarkHandlers &
  DiscoverySelectionHandlers & {
    handleClearDiscoveredFrames: () => Promise<void>;
    handleExportClick: () => void;
  };

export function useDiscoveryHandlers(params: UseDiscoveryHandlersParams): DiscoveryHandlers {
  // Session handlers (IO profile change, ingest, multi-bus, join)
  const sessionHandlers = useDiscoverySessionHandlers({
    setSourceProfileId: params.setSourceProfileId,
    setShowBusColumn: params.setShowBusColumn,
    watchSingleSource: params.watchSingleSource,
    watchMultiSource: params.watchMultiSource,
    ingestSingleSource: params.ingestSingleSource,
    ingestMultiSource: params.ingestMultiSource,
    selectProfile: params.selectProfile,
    selectMultipleProfiles: params.selectMultipleProfiles,
    joinSession: params.joinSession,
    updateCurrentTime: params.updateCurrentTime,
    setCurrentFrameIndex: params.setCurrentFrameIndex,
    setMaxBuffer: params.setMaxBuffer,
    clearBuffer: params.clearBuffer,
    clearFramePicker: params.clearFramePicker,
    clearAnalysisResults: params.clearAnalysisResults,
    enableBufferMode: params.enableBufferMode,
    disableBufferMode: params.disableBufferMode,
    setFrameInfoFromBuffer: params.setFrameInfoFromBuffer,
    clearSerialBytes: params.clearSerialBytes,
    resetFraming: params.resetFraming,
    setBackendByteCount: params.setBackendByteCount,
    addSerialBytes: params.addSerialBytes,
    setSerialConfig: params.setSerialConfig,
    setFramingConfig: params.setFramingConfig,
    showError: params.showError,
    setBufferMetadata: params.setBufferMetadata,
    closeIoReaderPicker: params.closeIoReaderPicker,
  });

  // Playback handlers (uses shared usePlaybackHandlers for play/pause/stop consistency)
  const playbackHandlers = useDiscoveryPlaybackHandlers({
    // Session state for shared handlers
    sessionId: params.sessionId,
    start: params.start,
    stop: params.stopWatch,
    pause: params.pause,
    resume: params.resume,
    setSpeed: params.setSpeed,
    setTimeRange: params.setTimeRange,
    seekByFrame: params.seekByFrame,
    isPaused: params.isPaused,
    isStreaming: params.isStreaming,
    sessionReady: params.sessionReady,
    isBufferMode: params.sessionIsBufferMode,
    currentFrameIndex: params.currentFrameIndex,
    currentTimestampUs: params.currentTimestampUs,
    selectedFrameIds: params.selectedFrames,
    // Time range state
    startTime: params.startTime,
    endTime: params.endTime,
    pendingSpeed: params.pendingSpeed,
    setPendingSpeed: params.setPendingSpeed,
    setActiveBookmarkId: params.setActiveBookmarkId,
    // Store actions
    setPlaybackSpeed: params.setPlaybackSpeed,
    updateCurrentTime: params.updateCurrentTime,
    setCurrentFrameIndex: params.setCurrentFrameIndex,
    setStartTime: params.setStartTime,
    setEndTime: params.setEndTime,
    clearBuffer: params.clearBuffer,
    clearFramePicker: params.clearFramePicker,
    resetWatchFrameCount: params.resetWatchFrameCount,
    closeSpeedChangeDialog: params.closeSpeedChangeDialog,
  });

  // Export handlers
  const exportHandlers = useDiscoveryExportHandlers({
    frames: params.frames,
    framedData: params.framedData,
    framedBufferId: params.framedBufferId,
    backendByteCount: params.backendByteCount,
    backendFrameCount: params.backendFrameCount,
    serialBytesBufferLength: params.serialBytesBufferLength,
    exportDataMode: params.exportDataMode,
    bufferModeEnabled: params.bufferModeEnabled,
    bufferModeTotalFrames: params.bufferModeTotalFrames,
    isSerialMode: params.isSerialMode,
    decoderDir: params.decoderDir,
    saveFrameIdFormat: params.saveFrameIdFormat,
    dumpDir: params.dumpDir,
    showError: params.showError,
    openSaveDialog: params.openSaveDialog,
    saveFrames: params.saveFrames,
    getBufferBytesPaginated: params.getBufferBytesPaginated,
    getBufferFramesPaginated: params.getBufferFramesPaginated,
    getBufferFramesPaginatedById: params.getBufferFramesPaginatedById,
    pickFileToSave: params.pickFileToSave,
    saveCatalog: params.saveCatalog,
    closeExportDialog: params.closeExportDialog,
  });

  // Bookmark handlers
  const bookmarkHandlers = useDiscoveryBookmarkHandlers({
    setBookmarkFrameId: params.setBookmarkFrameId,
    setBookmarkFrameTime: params.setBookmarkFrameTime,
    ioProfile: params.ioProfile,
    sourceProfileId: params.sourceProfileId,
    jumpToBookmark: params.jumpToBookmark,
    openBookmarkDialog: params.openBookmarkDialog,
  });

  // Selection handlers
  const selectionHandlers = useDiscoverySelectionHandlers({
    frameInfoMap: params.frameInfoMap,
    selectedFrames: params.selectedFrames,
    activeSelectionSetId: params.activeSelectionSetId,
    selectionSetDirty: params.selectionSetDirty,
    setActiveSelectionSet: params.setActiveSelectionSet,
    setSelectionSetDirty: params.setSelectionSetDirty,
    applySelectionSet: params.applySelectionSet,
    openSaveSelectionSetDialog: params.openSaveSelectionSetDialog,
  });

  // Handle clear discovered frames
  const handleClearDiscoveredFrames = useCallback(async () => {
    if (params.isSerialMode) {
      params.clearSerialBytes();
      params.resetFraming();
      params.clearBuffer();
      params.clearFramePicker();
      await params.clearBackendBuffer();
      if (isBufferProfileId(params.ioProfile) && params.sourceProfileId) {
        params.setIoProfile(params.sourceProfileId);
        await params.reinitialize(params.sourceProfileId);
      }
    } else {
      params.clearBuffer();
      params.clearFramePicker();
      await params.clearBackendBuffer();
      if (isBufferProfileId(params.ioProfile) && params.sourceProfileId) {
        params.setIoProfile(params.sourceProfileId);
        await params.reinitialize(params.sourceProfileId);
      }
    }
  }, [
    params.isSerialMode,
    params.clearSerialBytes,
    params.resetFraming,
    params.clearBuffer,
    params.clearFramePicker,
    params.clearBackendBuffer,
    params.ioProfile,
    params.sourceProfileId,
    params.setIoProfile,
    params.reinitialize,
  ]);

  // Handle export click (opens dialog)
  const handleExportClick = useCallback(() => {
    // This is a simple handler that will be connected to the dialog open function
    // in the component. We include it here for consistency.
  }, []);

  return {
    ...sessionHandlers,
    ...playbackHandlers,
    ...exportHandlers,
    ...bookmarkHandlers,
    ...selectionHandlers,
    handleClearDiscoveredFrames,
    handleExportClick,
  };
}
