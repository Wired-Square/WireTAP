// ui/src/apps/decoder/hooks/useDecoderHandlers.ts
//
// Orchestrator hook that composes all Decoder domain handlers.

import {
  useDecoderSessionHandlers,
  type DecoderSessionHandlers,
} from "./handlers/useDecoderSessionHandlers";
import {
  useDecoderPlaybackHandlers,
  type DecoderPlaybackHandlers,
} from "./handlers/useDecoderPlaybackHandlers";
import {
  useDecoderTimeHandlers,
  type DecoderTimeHandlers,
} from "./handlers/useDecoderTimeHandlers";
import {
  useDecoderSelectionHandlers,
  type DecoderSelectionHandlers,
} from "./handlers/useDecoderSelectionHandlers";
import {
  useDecoderCatalogHandlers,
  type DecoderCatalogHandlers,
} from "./handlers/useDecoderCatalogHandlers";
import type { PlaybackSpeed } from "../../../components/TimeController";
import type { IOCapabilities } from "../../../api/io";
import type { BufferMetadata } from "../../../api/buffer";
import type { FrameDetail } from "../../../types/decoder";
import type { IngestOptions as ManagerIngestOptions } from "../../../hooks/useIOSessionManager";
import type { TimeRangeFavorite } from "../../../utils/favorites";
// Note: SerialFrameConfig is read directly from store in session handlers to avoid stale closures
import type { SelectionSet } from "../../../utils/selectionSets";

export interface UseDecoderHandlersParams {
  // Session actions (low-level, for buffer reinitialize and playback)
  reinitialize: (
    profileId?: string,
    options?: {
      useBuffer?: boolean;
      speed?: number;
      startTime?: string;
      endTime?: string;
      limit?: number;
      framingEncoding?: "slip" | "modbus_rtu" | "delimiter" | "raw";
      frameIdStartByte?: number;
      frameIdBytes?: number;
      frameIdBigEndian?: boolean;
      sourceAddressStartByte?: number;
      sourceAddressBytes?: number;
      sourceAddressBigEndian?: boolean;
      minFrameLength?: number;
      emitRawBytes?: boolean;
    }
  ) => Promise<void>;
  start: () => Promise<void>;
  stop: () => Promise<void>;
  pause: () => Promise<void>;
  resume: () => Promise<void>;
  setSpeed: (speed: number) => Promise<void>;
  setTimeRange: (start?: string, end?: string) => Promise<void>;
  seek: (timeUs: number) => Promise<void>;
  seekByFrame: (frameIndex: number) => Promise<void>;

  // Reader state
  sessionId: string;
  isPaused: boolean;
  isStreaming: boolean;
  sessionReady: boolean;
  isBufferMode?: boolean;
  capabilities: IOCapabilities | null;
  currentFrameIndex?: number | null;
  currentTimestampUs?: number | null;

  // Store actions (decoder)
  setPlaybackSpeed: (speed: PlaybackSpeed) => void;
  setStartTime: (time: string) => void;
  setEndTime: (time: string) => void;
  updateCurrentTime: (time: number) => void;
  setCurrentFrameIndex: (index: number) => void;
  loadCatalog: (path: string) => Promise<void>;
  clearDecoded: () => void;
  clearUnmatchedFrames: () => void;
  clearFilteredFrames: () => void;
  setActiveSelectionSet: (id: string | null) => void;
  setSelectionSetDirty: (dirty: boolean) => void;
  applySelectionSet: (selectionSet: SelectionSet) => void;

  // Store state (decoder)
  frames: Map<number, FrameDetail>;
  selectedFrames: Set<number>;
  activeSelectionSetId: string | null;
  selectionSetDirty: boolean;
  startTime: string;
  endTime: string;
  playbackSpeed: PlaybackSpeed;
  ioProfile: string | null;
  // Note: serialConfig is read directly from store via getState() to avoid stale closure issues

  // Ingest session
  startIngest: (params: {
    profileId: string;
    speed?: number;
    startTime?: string;
    endTime?: string;
    maxFrames?: number;
    frameIdStartByte?: number;
    frameIdBytes?: number;
    sourceAddressStartByte?: number;
    sourceAddressBytes?: number;
    sourceAddressBigEndian?: boolean;
    minFrameLength?: number;
  }) => Promise<void>;
  stopIngest: () => Promise<void>;
  isIngesting: boolean;

  // Watch state (read-only, from manager)
  isWatching: boolean;

  // Stream completed ref (from manager, for playback handlers)
  streamCompletedRef: React.MutableRefObject<boolean>;

  // Manager session switching methods
  watchSingleSource: (profileId: string, options: ManagerIngestOptions, reinitializeOptions?: Record<string, unknown>) => Promise<void>;
  watchMultiSource: (profileIds: string[], options: ManagerIngestOptions) => Promise<void>;
  stopWatch: () => Promise<void>;
  selectProfile: (profileId: string | null) => void;
  selectMultipleProfiles: (profileIds: string[]) => void;
  joinSession: (sessionId: string, sourceProfileIds?: string[]) => Promise<void>;
  skipReader: () => Promise<void>;
  jumpToBookmark: (bookmark: TimeRangeFavorite, options?: Omit<ManagerIngestOptions, "startTime" | "endTime" | "maxFrames">) => Promise<void>;

  // Ingest speed
  ingestSpeed: number;
  setIngestSpeed: (speed: number) => void;

  // Dialog controls
  closeIoReaderPicker: () => void;
  openSaveSelectionSet: () => void;

  // Active tab
  activeTab: string;

  // Bookmark state
  setActiveBookmarkId: (id: string | null) => void;

  // Buffer state
  setBufferMetadata: (meta: BufferMetadata | null) => void;

  // Buffer bounds for frame index calculation during scrub
  minTimeUs?: number | null;
  maxTimeUs?: number | null;
  totalFrames?: number | null;
}

export type DecoderHandlers = DecoderSessionHandlers &
  DecoderPlaybackHandlers &
  DecoderTimeHandlers &
  DecoderSelectionHandlers &
  DecoderCatalogHandlers;

export function useDecoderHandlers(params: UseDecoderHandlersParams): DecoderHandlers {
  // Session handlers (start ingest, stop watch, detach, rejoin, multi-bus, IO profile change)
  // Delegates session orchestration to manager methods; only adds Decoder-specific logic
  const sessionHandlers = useDecoderSessionHandlers({
    reinitialize: params.reinitialize,
    startIngest: params.startIngest,
    stopIngest: params.stopIngest,
    isIngesting: params.isIngesting,
    isWatching: params.isWatching,
    // Manager session switching methods
    watchSingleSource: params.watchSingleSource,
    watchMultiSource: params.watchMultiSource,
    stopWatch: params.stopWatch,
    selectProfile: params.selectProfile,
    selectMultipleProfiles: params.selectMultipleProfiles,
    joinSession: params.joinSession,
    skipReader: params.skipReader,
    ingestSpeed: params.ingestSpeed,
    setIngestSpeed: params.setIngestSpeed,
    closeIoReaderPicker: params.closeIoReaderPicker,
    playbackSpeed: params.playbackSpeed,
    setBufferMetadata: params.setBufferMetadata,
    updateCurrentTime: params.updateCurrentTime,
    setCurrentFrameIndex: params.setCurrentFrameIndex,
  });

  // Playback handlers (play, pause, stop, speed change)
  const playbackHandlers = useDecoderPlaybackHandlers({
    sessionId: params.sessionId,
    start: params.start,
    stop: params.stop,
    pause: params.pause,
    resume: params.resume,
    setSpeed: params.setSpeed,
    isPaused: params.isPaused,
    isStreaming: params.isStreaming,
    sessionReady: params.sessionReady,
    isBufferMode: params.isBufferMode,
    currentFrameIndex: params.currentFrameIndex,
    currentTimestampUs: params.currentTimestampUs,
    selectedFrameIds: params.selectedFrames,
    setPlaybackSpeed: params.setPlaybackSpeed,
    updateCurrentTime: params.updateCurrentTime,
    setCurrentFrameIndex: params.setCurrentFrameIndex,
    streamCompletedRef: params.streamCompletedRef,
  });

  // Time handlers (scrub, start/end time change, load bookmark)
  const timeHandlers = useDecoderTimeHandlers({
    setTimeRange: params.setTimeRange,
    seek: params.seek,
    seekByFrame: params.seekByFrame,
    capabilities: params.capabilities,
    updateCurrentTime: params.updateCurrentTime,
    setCurrentFrameIndex: params.setCurrentFrameIndex,
    startTime: params.startTime,
    endTime: params.endTime,
    minTimeUs: params.minTimeUs,
    maxTimeUs: params.maxTimeUs,
    totalFrames: params.totalFrames,
    setActiveBookmarkId: params.setActiveBookmarkId,
    jumpToBookmark: params.jumpToBookmark,
  });

  // Selection handlers (save, load, clear selection sets)
  const selectionHandlers = useDecoderSelectionHandlers({
    frames: params.frames,
    selectedFrames: params.selectedFrames,
    activeSelectionSetId: params.activeSelectionSetId,
    selectionSetDirty: params.selectionSetDirty,
    setActiveSelectionSet: params.setActiveSelectionSet,
    setSelectionSetDirty: params.setSelectionSetDirty,
    applySelectionSet: params.applySelectionSet,
    openSaveSelectionSet: params.openSaveSelectionSet,
  });

  // Catalog handlers (catalog change, clear data)
  const catalogHandlers = useDecoderCatalogHandlers({
    loadCatalog: params.loadCatalog,
    clearDecoded: params.clearDecoded,
    clearUnmatchedFrames: params.clearUnmatchedFrames,
    clearFilteredFrames: params.clearFilteredFrames,
    activeTab: params.activeTab,
  });

  // Spread all handlers into a flat object
  return {
    ...sessionHandlers,
    ...playbackHandlers,
    ...timeHandlers,
    ...selectionHandlers,
    ...catalogHandlers,
  };
}
