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
import type { FrameDetail } from "../../../types/decoder";
import type { SerialFrameConfig } from "../../../utils/frameExport";
import type { SelectionSet } from "../../../utils/selectionSets";

export interface UseDecoderHandlersParams {
  // Session manager actions
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
  leave: () => Promise<void>;
  rejoin: (sessionId?: string, sessionName?: string) => Promise<void>;
  setSpeed: (speed: number) => Promise<void>;
  setTimeRange: (start?: string, end?: string) => Promise<void>;
  seek: (timeUs: number) => Promise<void>;

  // Reader state
  isPaused: boolean;
  capabilities: IOCapabilities | null;

  // Store actions (decoder)
  setIoProfile: (profileId: string | null) => void;
  setPlaybackSpeed: (speed: PlaybackSpeed) => void;
  setStartTime: (time: string) => void;
  setEndTime: (time: string) => void;
  updateCurrentTime: (time: number) => void;
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
  serialConfig: SerialFrameConfig | null;

  // Multi-bus state
  setMultiBusMode: (mode: boolean) => void;
  setMultiBusProfiles: (profiles: string[]) => void;
  profileNamesMap: Map<string, string>;

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

  // Watch state
  isWatching: boolean;
  setIsWatching: (watching: boolean) => void;
  setWatchFrameCount: (count: number | ((prev: number) => number)) => void;
  streamCompletedRef: React.MutableRefObject<boolean>;

  // Detached state
  setIsDetached: (detached: boolean) => void;

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

  // Settings for default speeds
  ioProfiles?: Array<{ id: string; connection?: { default_speed?: string } }>;
}

export type DecoderHandlers = DecoderSessionHandlers &
  DecoderPlaybackHandlers &
  DecoderTimeHandlers &
  DecoderSelectionHandlers &
  DecoderCatalogHandlers;

export function useDecoderHandlers(params: UseDecoderHandlersParams): DecoderHandlers {
  // Session handlers (start ingest, stop watch, detach, rejoin, multi-bus, IO profile change)
  const sessionHandlers = useDecoderSessionHandlers({
    reinitialize: params.reinitialize,
    stop: params.stop,
    leave: params.leave,
    rejoin: params.rejoin,
    setIoProfile: params.setIoProfile,
    setPlaybackSpeed: params.setPlaybackSpeed,
    setMultiBusMode: params.setMultiBusMode,
    setMultiBusProfiles: params.setMultiBusProfiles,
    profileNamesMap: params.profileNamesMap,
    startIngest: params.startIngest,
    stopIngest: params.stopIngest,
    isIngesting: params.isIngesting,
    serialConfig: params.serialConfig,
    isWatching: params.isWatching,
    setIsWatching: params.setIsWatching,
    setWatchFrameCount: params.setWatchFrameCount,
    streamCompletedRef: params.streamCompletedRef,
    setIsDetached: params.setIsDetached,
    ingestSpeed: params.ingestSpeed,
    setIngestSpeed: params.setIngestSpeed,
    closeIoReaderPicker: params.closeIoReaderPicker,
    playbackSpeed: params.playbackSpeed,
    ioProfiles: params.ioProfiles,
  });

  // Playback handlers (play, pause, stop, speed change)
  const playbackHandlers = useDecoderPlaybackHandlers({
    start: params.start,
    stop: params.stop,
    pause: params.pause,
    resume: params.resume,
    setSpeed: params.setSpeed,
    isPaused: params.isPaused,
    setPlaybackSpeed: params.setPlaybackSpeed,
    streamCompletedRef: params.streamCompletedRef,
  });

  // Time handlers (scrub, start/end time change, load bookmark)
  const timeHandlers = useDecoderTimeHandlers({
    setTimeRange: params.setTimeRange,
    seek: params.seek,
    capabilities: params.capabilities,
    setStartTime: params.setStartTime,
    setEndTime: params.setEndTime,
    updateCurrentTime: params.updateCurrentTime,
    startTime: params.startTime,
    endTime: params.endTime,
    setActiveBookmarkId: params.setActiveBookmarkId,
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
