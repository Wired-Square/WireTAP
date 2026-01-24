// ui/src/stores/discoveryUIStore.ts
//
// UI state and dialogs for Discovery app.
// Handles error dialogs, save dialogs, playback, time range, etc.

import { create } from 'zustand';
import { saveCatalog } from '../api';
import { buildFramesTomlWithKnowledge, type ExportFrameWithKnowledge, type SerialFrameConfig } from '../utils/frameExport';
import { formatFrameId } from '../utils/frameIds';
import { normalizeMeta } from '../utils/catalogMeta';
import type { FrameInfo } from './discoveryFrameStore';
import { useDiscoveryToolboxStore } from './discoveryToolboxStore';
import type { PlaybackSpeed } from '../components/TimeController';

// Re-export PlaybackSpeed for backwards compatibility
export type { PlaybackSpeed };

export type FrameMetadata = {
  name: string;
  version: number;
  default_byte_order: 'little' | 'big';
  default_interval: number;
  filename: string;
};

interface DiscoveryUIState {
  // General UI state
  error: string | null;
  maxBuffer: number;
  renderBuffer: number;
  ioProfile: string | null;

  // Playback control
  playbackSpeed: PlaybackSpeed;
  currentTime: number | null;

  // Time range
  startTime: string;
  endTime: string;

  // Error dialog state
  showErrorDialog: boolean;
  errorDialogTitle: string;
  errorDialogMessage: string;
  errorDialogDetails: string | null;

  // Save dialog state
  showSaveDialog: boolean;
  saveMetadata: FrameMetadata;
  serialConfig: SerialFrameConfig | null;

  // Selection set state
  activeSelectionSetId: string | null;
  selectionSetDirty: boolean;

  // Frame view tab state
  framesViewActiveTab: 'frames' | 'analysis';

  // CAN frame view display options
  showAsciiColumn: boolean;
  showBusColumn: boolean;

  // Actions - Error handling
  setError: (error: string | null) => void;
  showError: (title: string, message: string, details?: string) => void;
  closeErrorDialog: () => void;

  // Actions - UI settings
  setMaxBuffer: (value: number) => void;
  setRenderBuffer: (value: number) => void;
  setIoProfile: (profile: string | null) => void;

  // Actions - Playback control
  setPlaybackSpeed: (speed: PlaybackSpeed) => void;
  updateCurrentTime: (time: number) => void;

  // Actions - Time range
  setStartTime: (time: string) => void;
  setEndTime: (time: string) => void;

  // Actions - Save dialog
  openSaveDialog: () => void;
  closeSaveDialog: () => void;
  updateSaveMetadata: (metadata: FrameMetadata) => void;
  setSerialConfig: (config: SerialFrameConfig | null) => void;
  saveFrames: (
    decoderDir: string,
    saveFrameIdFormat: 'hex' | 'decimal',
    selectedFrames: Set<number>,
    frameInfoMap: Map<number, FrameInfo>
  ) => Promise<void>;

  // Actions - Selection sets
  setActiveSelectionSet: (id: string | null) => void;
  setSelectionSetDirty: (dirty: boolean) => void;

  // Actions - Frame view tabs
  setFramesViewActiveTab: (tab: 'frames' | 'analysis') => void;

  // Actions - CAN frame view display options
  toggleShowAsciiColumn: () => void;
  toggleShowBusColumn: () => void;
  setShowBusColumn: (show: boolean) => void;
}

export const useDiscoveryUIStore = create<DiscoveryUIState>((set, get) => ({
  // Initial state
  error: null,
  maxBuffer: 100000,
  renderBuffer: 20,
  ioProfile: null,
  playbackSpeed: 1,
  currentTime: null,
  startTime: '',
  endTime: '',
  showErrorDialog: false,
  errorDialogTitle: '',
  errorDialogMessage: '',
  errorDialogDetails: null,
  showSaveDialog: false,
  saveMetadata: {
    name: 'Discovered Frames',
    version: 1,
    default_byte_order: 'little',
    default_interval: 1000,
    filename: 'discovered-frames.toml',
  },
  serialConfig: null,
  activeSelectionSetId: null,
  selectionSetDirty: false,
  framesViewActiveTab: 'frames',
  showAsciiColumn: false,
  showBusColumn: false,

  // Error handling
  setError: (error) => set({ error }),

  showError: (title, message, details) => {
    set({
      showErrorDialog: true,
      errorDialogTitle: title,
      errorDialogMessage: message,
      errorDialogDetails: details || null,
    });
  },

  closeErrorDialog: () => {
    set({
      showErrorDialog: false,
      errorDialogTitle: '',
      errorDialogMessage: '',
      errorDialogDetails: null,
    });
  },

  // UI settings
  setMaxBuffer: (value) => {
    const clamped = Math.min(10000000, Math.max(100, value));
    set({ maxBuffer: clamped });
  },

  setRenderBuffer: (value) => {
    const clamped = value === -1 ? -1 : Math.min(10000, Math.max(20, value));
    set({ renderBuffer: clamped });
  },

  setIoProfile: (profile) => set({ ioProfile: profile }),

  // Playback control
  setPlaybackSpeed: (speed) => {
    set({ playbackSpeed: speed });
  },

  updateCurrentTime: (time) => set({ currentTime: time }),

  // Time range
  setStartTime: (time) => set({ startTime: time }),
  setEndTime: (time) => set({ endTime: time }),

  // Save dialog
  openSaveDialog: () => set({ showSaveDialog: true }),
  closeSaveDialog: () => set({ showSaveDialog: false }),
  updateSaveMetadata: (metadata) => set({ saveMetadata: metadata }),

  setSerialConfig: (config) => {
    if (config === null) {
      set({ serialConfig: null });
    } else {
      const { serialConfig: existing } = get();
      set({ serialConfig: { ...existing, ...config } });
    }
  },

  saveFrames: async (decoderDir, saveFrameIdFormat, selectedFrames, frameInfoMap) => {
    const { knowledge, toolbox } = useDiscoveryToolboxStore.getState();

    const { saveMetadata, serialConfig } = get();

    if (!decoderDir) {
      set({ error: 'Decoder directory is not set in settings.' });
      return;
    }

    const safeFilename = saveMetadata.filename.trim() || 'discovered-frames.toml';
    const filename = safeFilename.endsWith('.toml') ? safeFilename : `${safeFilename}.toml`;
    const baseDir = decoderDir.replace(/[\\/]+$/, '');
    const path = `${baseDir}/${filename}`;

    const selectedFramesList: ExportFrameWithKnowledge[] = Array.from(frameInfoMap.entries())
      .filter(([id]) => selectedFrames.has(id))
      .map(([id, info]) => ({
        id,
        len: info.len,
        isExtended: info.isExtended,
        protocol: info.protocol,
        knowledge: knowledge.frames.get(id),
      }))
      .sort((a, b) => a.id - b.id);

    const detectedProtocol = selectedFramesList.find(f => f.protocol)?.protocol ?? 'can';
    const defaultInterval = knowledge.meta.defaultInterval ?? saveMetadata.default_interval;
    // Use detected byte order from analysis if available, otherwise use user selection
    const defaultByteOrder = knowledge.analysisRun
      ? knowledge.meta.defaultEndianness
      : saveMetadata.default_byte_order;

    const normalizedMeta = normalizeMeta({
      name: saveMetadata.name,
      version: saveMetadata.version,
      default_byte_order: defaultByteOrder,
      default_interval: defaultInterval,
      default_frame: detectedProtocol,
    });

    let enrichedSerialConfig = serialConfig;
    if (detectedProtocol === 'serial') {
      const serialAnalysis = toolbox.serialPayloadResults?.analysisResult;
      const bestChecksum = serialAnalysis?.candidateChecksums
        ?.filter((c: { matchRate: number }) => c.matchRate >= 90)
        ?.sort((a: { matchRate: number }, b: { matchRate: number }) => b.matchRate - a.matchRate)[0];

      if (bestChecksum) {
        enrichedSerialConfig = {
          ...serialConfig,
          checksum: {
            algorithm: bestChecksum.algorithm,
            start_byte: bestChecksum.position,
            byte_length: bestChecksum.length,
            calc_start_byte: bestChecksum.calcStartByte,
            calc_end_byte: bestChecksum.calcEndByte,
          },
        };
      }
    }

    const content = buildFramesTomlWithKnowledge(
      selectedFramesList,
      normalizedMeta,
      (id: number, isExtended?: boolean) => formatFrameId(id, saveFrameIdFormat, isExtended),
      detectedProtocol === 'serial' ? enrichedSerialConfig ?? undefined : undefined
    );

    await saveCatalog(path, content);
    set({ showSaveDialog: false });
  },

  // Selection sets
  setActiveSelectionSet: (id) => set({ activeSelectionSetId: id }),
  setSelectionSetDirty: (dirty) => set({ selectionSetDirty: dirty }),

  // Frame view tabs
  setFramesViewActiveTab: (tab) => set({ framesViewActiveTab: tab }),

  // CAN frame view display options
  toggleShowAsciiColumn: () => set((state) => ({ showAsciiColumn: !state.showAsciiColumn })),
  toggleShowBusColumn: () => set((state) => ({ showBusColumn: !state.showBusColumn })),
  setShowBusColumn: (show) => set({ showBusColumn: show }),
}));
