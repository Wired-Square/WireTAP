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
import { useTimeHandlers, type TimeHandlers } from "../../../hooks/useTimeHandlers";
import type { PlaybackSpeed, FrameMessage } from "../../../stores/discoveryStore";
import type { BufferMetadata, TimestampedByte } from "../../../api/buffer";
import type { ExportDataMode } from "../../../dialogs/ExportFramesDialog";
import type { SelectionSet } from "../../../utils/selectionSets";
import { isBufferProfileId, type IngestOptions as ManagerIngestOptions } from "../../../hooks/useIOSessionManager";
import type { TimeRangeFavorite } from "../../../utils/favorites";

export interface UseDiscoveryHandlersParams {
  // Session state
  sessionId: string;
  isStreaming: boolean;
  isPaused: boolean;
  sessionReady: boolean;
  ioProfile: string | null;
  sourceProfileId: string | null;
  playbackSpeed: PlaybackSpeed;
  /** Whether the session is stopped (used for play/resume/step logic) */
  isStopped: boolean;
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
  stopWatch: () => Promise<void>;
  selectProfile: (profileId: string | null) => void;
  watchSingleSource: (profileId: string, options: ManagerIngestOptions) => Promise<void>;
  jumpToBookmark: (bookmark: TimeRangeFavorite, options?: Omit<ManagerIngestOptions, "startTime" | "endTime" | "maxFrames">) => Promise<void>;

  // Session actions
  setIoProfile: (profileId: string | null) => void;
  start: () => Promise<void>;
  pause: () => Promise<void>;
  resume: () => Promise<void>;
  reinitialize: (profileId?: string, options?: any) => Promise<void>;
  setSpeed: (speed: number) => Promise<void>;
  setTimeRange: (start: string, end: string) => Promise<void>;
  seek: (timestampUs: number) => Promise<void>;
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
  /** Called after a selection set is saved or updated */
  onAfterSelectionSetMutate?: () => void;
  closeExportDialog: () => void;
}

export type DiscoveryHandlers = DiscoverySessionHandlers &
  DiscoveryPlaybackHandlers &
  TimeHandlers &
  DiscoveryExportHandlers &
  DiscoveryBookmarkHandlers &
  DiscoverySelectionHandlers & {
    handleClearDiscoveredFrames: () => Promise<void>;
    handleExportClick: () => void;
  };

export function useDiscoveryHandlers(params: UseDiscoveryHandlersParams): DiscoveryHandlers {
  // Session handlers (IO profile change, buffer switching)
  // Note: Dialog handlers (start/stop ingest, join, skip, multi-select) are centralised
  // in useIOPickerHandlers, called directly from Discovery.tsx.
  const sessionHandlers = useDiscoverySessionHandlers({
    selectProfile: params.selectProfile,
    watchSingleSource: params.watchSingleSource,
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
    setBufferMetadata: params.setBufferMetadata,
  });

  // Playback handlers (uses shared usePlaybackHandlers for play/pause/stop consistency)
  const playbackHandlers = useDiscoveryPlaybackHandlers({
    sessionId: params.sessionId,
    start: params.start,
    stop: params.stopWatch,
    pause: params.pause,
    resume: params.resume,
    setSpeed: params.setSpeed,
    seek: params.seek,
    isPaused: params.isPaused,
    isStreaming: params.isStreaming,
    sessionReady: params.sessionReady,
    isStopped: params.isStopped,
    currentFrameIndex: params.currentFrameIndex,
    currentTimestampUs: params.currentTimestampUs,
    selectedFrameIds: params.selectedFrames,
    pendingSpeed: params.pendingSpeed,
    setPendingSpeed: params.setPendingSpeed,
    setPlaybackSpeed: params.setPlaybackSpeed,
    updateCurrentTime: params.updateCurrentTime,
    setCurrentFrameIndex: params.setCurrentFrameIndex,
    clearBuffer: params.clearBuffer,
    clearFramePicker: params.clearFramePicker,
    resetWatchFrameCount: params.resetWatchFrameCount,
    closeSpeedChangeDialog: params.closeSpeedChangeDialog,
  });

  // Time handlers (shared: time range, frame change, bookmark load)
  const timeHandlers = useTimeHandlers({
    setTimeRange: params.setTimeRange,
    seekByFrame: params.seekByFrame,
    setCurrentFrameIndex: params.setCurrentFrameIndex,
    startTime: params.startTime,
    endTime: params.endTime,
    setActiveBookmarkId: params.setActiveBookmarkId,
    jumpToBookmark: params.jumpToBookmark,
    onStartTimeChange: params.setStartTime,
    onEndTimeChange: params.setEndTime,
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
    openSaveDialog: params.openSaveDialog,
    saveFrames: params.saveFrames,
    getBufferBytesPaginated: params.getBufferBytesPaginated,
    getBufferFramesPaginated: params.getBufferFramesPaginated,
    getBufferFramesPaginatedById: params.getBufferFramesPaginatedById,
    pickFileToSave: params.pickFileToSave,
    saveCatalog: params.saveCatalog,
    closeExportDialog: params.closeExportDialog,
  });

  // Bookmark handlers (bookmark UI + save; load is in shared timeHandlers)
  const bookmarkHandlers = useDiscoveryBookmarkHandlers({
    setBookmarkFrameId: params.setBookmarkFrameId,
    setBookmarkFrameTime: params.setBookmarkFrameTime,
    ioProfile: params.ioProfile,
    sourceProfileId: params.sourceProfileId,
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
    onAfterMutate: params.onAfterSelectionSetMutate,
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
    ...timeHandlers,
    ...exportHandlers,
    ...bookmarkHandlers,
    ...selectionHandlers,
    handleClearDiscoveredFrames,
    handleExportClick,
  };
}
