// ui/src/stores/discoveryUIStore.ts
//
// UI state and dialogs for Discovery app.
// Handles error dialogs, save dialogs, playback, time range, etc.

import { create } from 'zustand';
import i18n from 'i18next';
import { saveCatalog } from '../api';
import { buildCatalog } from '../api/catalog';
import { draftCatalog, type Draft, type DraftFrame } from '../api/drafting';
import { withAppError } from '../utils/appError';
import { frameNoteLines } from '../utils/analysis/byteNoteText';
import { catalogProtocol, headOps, modbusCatalogOps, serialReservedSpans, type SerialFrameConfig, type ModbusExportConfig } from '../utils/frameExport';
import { parseFrameKey } from '../utils/frameKey';
import { normalizeMeta } from '../utils/catalogMeta';
import { configFromCandidate, serialChecksumFromConfig } from '../apps/discovery/views/serial/checksumConfig';
import type { FrameInfo } from './discoveryFrameStore';
import { useDiscoveryToolboxStore } from './discoveryToolboxStore';
import { useSessionStore } from './sessionStore';
import type { PlaybackSpeed } from '../components/TimeController';
import type { PageSize } from "../utils/pageSize";

// Re-export PlaybackSpeed for backwards compatibility
export type { PlaybackSpeed };

export type FrameMetadata = {
  name: string;
  version: number;
  default_byte_order: 'little' | 'big';
  default_interval: number;
  filename: string;
};

/** A frame's notes from the draft, worded. */
function draftNotes(draft: Draft | null, frame: DraftFrame): string[] {
  const known = draft?.frames.find(
    (d) => d.protocol === frame.protocol && d.frameId === frame.frameId && d.isExtended === frame.isExtended,
  );
  return known ? frameNoteLines(i18n.t.bind(i18n), known.notes, known.mux?.selector) : [];
}

interface DiscoveryUIState {
  // General UI state
  maxBuffer: number;
  renderBuffer: PageSize;
  ioProfile: string | null;

  // Playback control
  playbackSpeed: PlaybackSpeed;
  currentTime: number | null;
  currentFrameIndex: number | null;

  // Time range
  startTime: string;
  endTime: string;

  // Save dialog state
  showSaveDialog: boolean;
  saveMetadata: FrameMetadata;
  serialConfig: SerialFrameConfig | null;
  /** Modbus-specific export configuration, set when a scan completes */
  modbusExportConfig: ModbusExportConfig | null;

  // Selection set state
  activeSelectionSetId: string | null;
  selectionSetDirty: boolean;
  /** Cached selectedIds from the active selection set — used to gate auto-selection during ingestion.
   *  Keys are composite frame keys (e.g. "can:256"). */
  activeSelectionSetSelectedIds: Set<string> | null;

  // Frame view tab state
  framesViewActiveTab: string;

  // CAN frame view display options
  showRefColumn: boolean;
  showAsciiColumn: boolean;
  showBusColumn: boolean;
  showSourceColumn: boolean;

  // Actions - UI settings
  setMaxBuffer: (value: number) => void;
  setRenderBuffer: (value: PageSize) => void;
  setIoProfile: (profile: string | null) => void;

  // Actions - Playback control
  setPlaybackSpeed: (speed: PlaybackSpeed) => void;
  updateCurrentTime: (time: number | null) => void;
  setCurrentFrameIndex: (index: number | null) => void;

  // Actions - Time range
  setStartTime: (time: string) => void;
  setEndTime: (time: string) => void;

  // Actions - Save dialog
  openSaveDialog: () => void;
  closeSaveDialog: () => void;
  updateSaveMetadata: (metadata: FrameMetadata) => void;
  setSerialConfig: (config: SerialFrameConfig | null) => void;
  setModbusExportConfig: (config: ModbusExportConfig | null) => void;
  saveFrames: (
    decoderDir: string,
    saveFrameIdFormat: 'hex' | 'decimal',
    selectedFrames: Set<string>,
    frameInfoMap: Map<string, FrameInfo>
  ) => Promise<void>;

  // Actions - Selection sets
  setActiveSelectionSet: (id: string | null) => void;
  setSelectionSetDirty: (dirty: boolean) => void;
  setActiveSelectionSetSelectedIds: (ids: Set<string> | null) => void;

  // Actions - Frame view tabs
  setFramesViewActiveTab: (tab: string) => void;

  // Actions - CAN frame view display options
  toggleShowRefColumn: () => void;
  toggleShowAsciiColumn: () => void;
  toggleShowBusColumn: () => void;
  toggleShowSourceColumn: () => void;
  setShowBusColumn: (show: boolean) => void;
}

export const useDiscoveryUIStore = create<DiscoveryUIState>((set, get) => ({
  // Initial state
  maxBuffer: 100000,
  renderBuffer: "auto",
  ioProfile: null,
  playbackSpeed: 1,
  currentTime: null,
  currentFrameIndex: null,
  startTime: '',
  endTime: '',
  showSaveDialog: false,
  saveMetadata: {
    name: 'Discovered Frames',
    version: 1,
    default_byte_order: 'little',
    default_interval: 1000,
    filename: 'discovered-frames.toml',
  },
  serialConfig: null,
  modbusExportConfig: null,
  activeSelectionSetId: null,
  selectionSetDirty: false,
  activeSelectionSetSelectedIds: null,
  framesViewActiveTab: 'frames',
  showRefColumn: true,
  showAsciiColumn: false,
  showBusColumn: false,
  showSourceColumn: false,

  // UI settings
  setMaxBuffer: (value) => {
    const clamped = Math.min(10000000, Math.max(100, value));
    set({ maxBuffer: clamped });
  },

  setRenderBuffer: (value) =>
    set({
      renderBuffer:
        typeof value === "number" ? Math.min(10000, Math.max(20, value)) : value,
    }),

  setIoProfile: (profile) => set({ ioProfile: profile }),

  // Playback control
  setPlaybackSpeed: (speed) => {
    set({ playbackSpeed: speed });
  },

  updateCurrentTime: (time) => set({ currentTime: time }),
  setCurrentFrameIndex: (index) => set({ currentFrameIndex: index }),

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

  setModbusExportConfig: (config) => {
    set({ modbusExportConfig: config });
  },

  saveFrames: async (decoderDir, saveFrameIdFormat, selectedFrames, frameInfoMap) => {
    const { draft, toolbox } = useDiscoveryToolboxStore.getState();

    const { saveMetadata, serialConfig } = get();

    if (!decoderDir) {
      useSessionStore.getState().showAppError('Save Error', 'Decoder directory is not set in settings.');
      return;
    }

    const safeFilename = saveMetadata.filename.trim() || 'discovered-frames.toml';
    const filename = safeFilename.endsWith('.toml') ? safeFilename : `${safeFilename}.toml`;
    const baseDir = decoderDir.replace(/[\\/]+$/, '');
    const path = `${baseDir}/${filename}`;
    const saveBuilt = async (build: () => Promise<string>) => {
      const saved = await withAppError('Save Error', 'The catalogue was not saved', async () => {
        await saveCatalog(path, await build());
      });
      if (saved) set({ showSaveDialog: false });
    };

    const selectedFramesList: DraftFrame[] = Array.from(frameInfoMap.entries())
      .filter(([fk]) => selectedFrames.has(fk))
      .map(([fk, info]) => ({
        protocol: info.protocol ?? 'can',
        frameId: parseFrameKey(fk).frameId,
        isExtended: !!info.isExtended,
        length: info.len,
      }))
      .sort((a, b) => a.frameId - b.frameId);

    const detectedProtocol = selectedFramesList.find(f => f.protocol)?.protocol ?? 'can';
    const defaultInterval = draft?.defaultIntervalMs ?? saveMetadata.default_interval;
    // Use detected byte order from analysis if available, otherwise use user selection
    const defaultByteOrder = draft?.defaultEndianness ?? saveMetadata.default_byte_order;

    const normalizedMeta = normalizeMeta({
      name: saveMetadata.name,
      version: saveMetadata.version,
      default_byte_order: defaultByteOrder,
      default_interval: defaultInterval,
      default_frame: detectedProtocol,
    });

    // Modbus protocol: use specialised TOML export
    const { modbusExportConfig } = get();
    if (detectedProtocol === 'modbus' && modbusExportConfig) {
      const registers = selectedFramesList.map(f => ({
        frameId: f.frameId,
        dlc: f.length,
      }));
      await saveBuilt(() => buildCatalog(modbusCatalogOps(registers, normalizedMeta, { ...modbusExportConfig, default_interval: defaultInterval })));
      return;
    }

    let enrichedSerialConfig = serialConfig;
    // Fill in a checksum only when none was chosen. This used to overwrite
    // unconditionally, so a configuration set in the Configure Checksum dialog was
    // silently replaced at save time by whatever the Serial Payload tool last saw.
    if (detectedProtocol === 'serial' && !serialConfig?.checksum) {
      const serialAnalysis = toolbox.serialPayloadResults?.analysisResult;
      const bestChecksum = serialAnalysis?.candidateChecksums
        ?.filter((c: { matchRate: number }) => c.matchRate >= 90)
        ?.sort((a: { matchRate: number }, b: { matchRate: number }) => b.matchRate - a.matchRate)[0];

      if (bestChecksum) {
        enrichedSerialConfig = {
          ...serialConfig,
          checksum: serialChecksumFromConfig(configFromCandidate(bestChecksum)) ?? undefined,
        };
      }
    }

    const serial = detectedProtocol === 'serial' ? enrichedSerialConfig ?? undefined : undefined;
    await saveBuilt(() => {
      const head = headOps(catalogProtocol(selectedFramesList), normalizedMeta, serial);
      return draftCatalog(draft, head, {
        frames: selectedFramesList,
        notes: selectedFramesList.map((f) => draftNotes(draft, f)),
        defaultEndianness: normalizedMeta.default_byte_order,
        defaultIntervalMs: normalizedMeta.default_interval,
        serialReserved: serialReservedSpans(serial),
        decimalIds: saveFrameIdFormat === 'decimal',
      });
    });
  },

  // Selection sets
  setActiveSelectionSet: (id) => set({ activeSelectionSetId: id }),
  setSelectionSetDirty: (dirty) => set({ selectionSetDirty: dirty }),
  setActiveSelectionSetSelectedIds: (ids) => set({ activeSelectionSetSelectedIds: ids }),

  // Frame view tabs
  setFramesViewActiveTab: (tab) => set({ framesViewActiveTab: tab }),

  // CAN frame view display options
  toggleShowRefColumn: () => set((state) => ({ showRefColumn: !state.showRefColumn })),
  toggleShowAsciiColumn: () => set((state) => ({ showAsciiColumn: !state.showAsciiColumn })),
  toggleShowBusColumn: () => set((state) => ({ showBusColumn: !state.showBusColumn })),
  toggleShowSourceColumn: () => set((state) => ({ showSourceColumn: !state.showSourceColumn })),
  setShowBusColumn: (show) => set({ showBusColumn: show }),
}));
