// ui/src/stores/discoveryFrameStore.ts
//
// Frame data and selection state for Discovery app.
// Handles frame buffer, frame info map, and selection.

import { create } from 'zustand';
import type { FrameMessage } from '../types/frame';
import type { SelectionSet } from '../utils/selectionSets';

// Frame buffer for throttling UI updates
let pendingFrames: FrameMessage[] = [];
let flushTimeout: ReturnType<typeof setTimeout> | null = null;
const FLUSH_INTERVAL_MS = 40;

export type FrameInfo = {
  len: number;
  isExtended?: boolean;
  bus?: number;
  lenMismatch?: boolean;
  protocol?: string;
};

interface DiscoveryFrameState {
  // Frame data
  frames: FrameMessage[];
  frameInfoMap: Map<number, FrameInfo>;
  selectedFrames: Set<number>;
  seenIds: Set<number>;

  // Stream timing
  streamStartTimeUs: number | null;

  // Buffer mode (for large datasets)
  bufferMode: {
    enabled: boolean;
    totalFrames: number;
    /** View mode: pagination = manual page navigation, playback = timeline-controlled */
    viewMode: "pagination" | "playback";
  };

  // Actions - Data management
  addFrames: (newFrames: FrameMessage[], maxBuffer: number, skipFramePicker?: boolean, activeSelectionSetSelectedIds?: Set<number> | null) => void;
  clearBuffer: () => void;
  clearFramePicker: () => void;
  clearAll: () => void;
  setFrames: (frames: FrameMessage[]) => void;
  rebuildFramePickerFromBuffer: (activeSelectionSetSelectedIds?: Set<number> | null) => void;

  // Actions - Frame selection
  toggleFrameSelection: (id: number, activeSelectionSetId: string | null, setDirty: (dirty: boolean) => void) => void;
  bulkSelectBus: (bus: number | null, select: boolean, activeSelectionSetId: string | null, setDirty: (dirty: boolean) => void) => void;
  selectAllFrames: (activeSelectionSetId: string | null, setDirty: (dirty: boolean) => void) => void;
  deselectAllFrames: (activeSelectionSetId: string | null, setDirty: (dirty: boolean) => void) => void;
  applySelectionSet: (selectionSet: SelectionSet, setActiveId: (id: string | null) => void, setDirty: (dirty: boolean) => void) => void;

  // Actions - Buffer mode
  enableBufferMode: (totalFrames: number) => void;
  disableBufferMode: () => void;
  setBufferViewMode: (mode: "pagination" | "playback") => void;
  setFrameInfoFromBuffer: (frameInfoList: Array<{
    frame_id: number;
    max_dlc: number;
    bus: number;
    is_extended: boolean;
    has_dlc_mismatch: boolean;
  }>, protocol?: string, activeSelectionSetSelectedIds?: Set<number> | null) => void;
}

export const useDiscoveryFrameStore = create<DiscoveryFrameState>((set, get) => ({
  // Initial state
  frames: [],
  frameInfoMap: new Map(),
  selectedFrames: new Set(),
  seenIds: new Set(),
  streamStartTimeUs: null,
  bufferMode: { enabled: false, totalFrames: 0, viewMode: "pagination" },

  // Data management actions
  addFrames: (newFrames, maxBuffer, skipFramePicker = false, activeSelectionSetSelectedIds = null) => {
    pendingFrames.push(...newFrames);

    if (flushTimeout === null) {
      flushTimeout = setTimeout(() => {
        flushTimeout = null;
        const framesToProcess = pendingFrames;
        pendingFrames = [];

        if (framesToProcess.length === 0) return;

        const { frames, frameInfoMap, seenIds, selectedFrames, streamStartTimeUs } = get();

        if (streamStartTimeUs === null && framesToProcess.length > 0) {
          const earliestTs = Math.min(...framesToProcess.map(f => f.timestamp_us));
          set({ streamStartTimeUs: earliestTs });
        }

        let updatedFrames: FrameMessage[];
        const totalNeeded = frames.length + framesToProcess.length;

        if (totalNeeded <= maxBuffer) {
          updatedFrames = frames.concat(framesToProcess);
        } else {
          const keepFromOld = Math.max(0, maxBuffer - framesToProcess.length);
          if (keepFromOld === 0) {
            updatedFrames = framesToProcess.slice(-maxBuffer);
          } else {
            updatedFrames = frames.slice(-keepFromOld).concat(framesToProcess);
          }
        }

        const stateUpdate: Partial<DiscoveryFrameState> = { frames: updatedFrames };

        // Skip frame picker updates if requested (e.g., serial mode before framing is accepted)
        if (!skipFramePicker) {
          const newlyDiscovered: number[] = [];
          for (const f of framesToProcess) {
            if (!seenIds.has(f.frame_id)) {
              newlyDiscovered.push(f.frame_id);
            }
          }

          if (newlyDiscovered.length > 0) {
            const nextSeenIds = new Set(seenIds);
            const nextSelectedFrames = new Set(selectedFrames);
            newlyDiscovered.forEach((id) => {
              nextSeenIds.add(id);
              // When a selection set is active, only auto-select frames that are in the set
              if (activeSelectionSetSelectedIds) {
                if (activeSelectionSetSelectedIds.has(id)) {
                  nextSelectedFrames.add(id);
                }
              } else {
                nextSelectedFrames.add(id);
              }
            });
            stateUpdate.seenIds = nextSeenIds;
            stateUpdate.selectedFrames = nextSelectedFrames;
          }

          // Update frame info map
          let frameInfoChanged = newlyDiscovered.length > 0;

          if (!frameInfoChanged) {
            for (const f of framesToProcess) {
              const current = frameInfoMap.get(f.frame_id);
              if (current) {
                const newLen = Math.max(current.len, f.dlc);
                const lenMismatch = current.lenMismatch || current.len !== f.dlc;
                if (current.len !== newLen || current.lenMismatch !== lenMismatch) {
                  frameInfoChanged = true;
                  break;
                }
              }
            }
          }

          if (frameInfoChanged) {
            const nextFrameInfoMap = new Map(frameInfoMap);

            for (const f of framesToProcess) {
              const current = nextFrameInfoMap.get(f.frame_id);
              const newLen = current ? Math.max(current.len, f.dlc) : f.dlc;
              const newBus = current?.bus ?? f.bus;
              const newExtended = current?.isExtended ?? f.is_extended;
              const lenMismatch = current ? current.lenMismatch || current.len !== f.dlc : false;
              const protocol = current?.protocol ?? f.protocol;

              if (
                !current ||
                current.len !== newLen ||
                current.isExtended !== newExtended ||
                current.bus !== newBus ||
                current.lenMismatch !== lenMismatch ||
                current.protocol !== protocol
              ) {
                nextFrameInfoMap.set(f.frame_id, { len: newLen, isExtended: newExtended, bus: newBus, lenMismatch, protocol });
              }
            }

            stateUpdate.frameInfoMap = nextFrameInfoMap;
          }
        }

        set(stateUpdate);
      }, FLUSH_INTERVAL_MS);
    }
  },

  clearBuffer: () => {
    pendingFrames = [];
    if (flushTimeout !== null) {
      clearTimeout(flushTimeout);
      flushTimeout = null;
    }
    set({ frames: [], streamStartTimeUs: null });
  },

  clearFramePicker: () => {
    set({
      frameInfoMap: new Map(),
      selectedFrames: new Set(),
      seenIds: new Set(),
    });
  },

  clearAll: () => {
    pendingFrames = [];
    if (flushTimeout !== null) {
      clearTimeout(flushTimeout);
      flushTimeout = null;
    }
    set({
      frames: [],
      frameInfoMap: new Map(),
      selectedFrames: new Set(),
      seenIds: new Set(),
      streamStartTimeUs: null,
    });
  },

  setFrames: (frames) => {
    set({ frames });
    get().rebuildFramePickerFromBuffer();
  },

  rebuildFramePickerFromBuffer: (activeSelectionSetSelectedIds = null) => {
    const { frames } = get();
    if (frames.length === 0) return;

    console.log(`[rebuildFramePickerFromBuffer] Building frame picker from ${frames.length} frames`);

    const nextSeenIds = new Set<number>();
    const nextFrameInfoMap = new Map<number, FrameInfo>();
    const nextSelectedFrames = new Set<number>();

    for (const f of frames) {
      if (!nextSeenIds.has(f.frame_id)) {
        nextSeenIds.add(f.frame_id);
        if (activeSelectionSetSelectedIds) {
          if (activeSelectionSetSelectedIds.has(f.frame_id)) {
            nextSelectedFrames.add(f.frame_id);
          }
        } else {
          nextSelectedFrames.add(f.frame_id);
        }
      }

      const current = nextFrameInfoMap.get(f.frame_id);
      const newLen = current ? Math.max(current.len, f.dlc) : f.dlc;
      const newBus = current?.bus ?? f.bus;
      const newExtended = current?.isExtended ?? f.is_extended;
      const lenMismatch = current ? current.lenMismatch || current.len !== f.dlc : false;
      const protocol = current?.protocol ?? f.protocol;

      if (
        !current ||
        current.len !== newLen ||
        current.isExtended !== newExtended ||
        current.bus !== newBus ||
        current.lenMismatch !== lenMismatch ||
        current.protocol !== protocol
      ) {
        nextFrameInfoMap.set(f.frame_id, { len: newLen, isExtended: newExtended, bus: newBus, lenMismatch, protocol });
      }
    }

    console.log(`[rebuildFramePickerFromBuffer] Found ${nextSeenIds.size} unique frame IDs`);

    set({
      seenIds: nextSeenIds,
      frameInfoMap: nextFrameInfoMap,
      selectedFrames: nextSelectedFrames,
    });
  },

  // Frame selection actions
  toggleFrameSelection: (id, activeSelectionSetId, setDirty) => {
    const { selectedFrames } = get();
    const next = new Set(selectedFrames);
    if (next.has(id)) {
      next.delete(id);
    } else {
      next.add(id);
    }
    set({ selectedFrames: next });
    if (activeSelectionSetId !== null) {
      setDirty(true);
    }
  },

  bulkSelectBus: (bus, select, activeSelectionSetId, setDirty) => {
    const { frameInfoMap, selectedFrames } = get();
    const ids = Array.from(frameInfoMap.entries())
      .filter(([, info]) => bus === null ? info.bus === undefined : info.bus === bus)
      .map(([id]) => id);

    if (ids.length === 0) return;

    const next = new Set(selectedFrames);
    ids.forEach((id) => {
      if (select) {
        next.add(id);
      } else {
        next.delete(id);
      }
    });
    set({ selectedFrames: next });
    if (activeSelectionSetId !== null) {
      setDirty(true);
    }
  },

  selectAllFrames: (activeSelectionSetId, setDirty) => {
    const { frameInfoMap } = get();
    const allIds = new Set(frameInfoMap.keys());
    set({ selectedFrames: allIds });
    if (activeSelectionSetId !== null) {
      setDirty(true);
    }
  },

  deselectAllFrames: (activeSelectionSetId, setDirty) => {
    set({ selectedFrames: new Set() });
    if (activeSelectionSetId !== null) {
      setDirty(true);
    }
  },

  applySelectionSet: (selectionSet, setActiveId, setDirty) => {
    const { frameInfoMap, seenIds } = get();

    const newFrameInfoMap = new Map(frameInfoMap);
    const newSeenIds = new Set(seenIds);
    const newSelectedFrames = new Set<number>();

    for (const frameId of selectionSet.frameIds) {
      if (!newFrameInfoMap.has(frameId)) {
        newFrameInfoMap.set(frameId, {
          len: 8,
          isExtended: frameId > 0x7ff,
          bus: undefined,
          lenMismatch: false,
        });
        newSeenIds.add(frameId);
      }
    }

    const idsToSelect = selectionSet.selectedIds ?? selectionSet.frameIds;
    for (const frameId of idsToSelect) {
      newSelectedFrames.add(frameId);
    }

    set({
      frameInfoMap: newFrameInfoMap,
      seenIds: newSeenIds,
      selectedFrames: newSelectedFrames,
    });
    setActiveId(selectionSet.id);
    setDirty(false);
  },

  // Buffer mode actions
  enableBufferMode: (totalFrames) => {
    console.log(`[discoveryFrameStore] Enabling buffer mode with ${totalFrames} frames`);
    set({
      bufferMode: { enabled: true, totalFrames, viewMode: "pagination" },
      frames: [],
    });
  },

  disableBufferMode: () => {
    console.log('[discoveryFrameStore] Disabling buffer mode');
    set({
      bufferMode: { enabled: false, totalFrames: 0, viewMode: "pagination" },
    });
  },

  setBufferViewMode: (mode) => {
    set((state) => ({
      bufferMode: { ...state.bufferMode, viewMode: mode },
    }));
  },

  setFrameInfoFromBuffer: (frameInfoList, protocol, activeSelectionSetSelectedIds = null) => {
    console.log(`[discoveryFrameStore] Setting frame info from buffer: ${frameInfoList.length} unique frames, protocol: ${protocol || 'can'}`);

    const nextSeenIds = new Set<number>();
    const nextFrameInfoMap = new Map<number, FrameInfo>();
    const nextSelectedFrames = new Set<number>();

    for (const info of frameInfoList) {
      nextSeenIds.add(info.frame_id);
      if (activeSelectionSetSelectedIds) {
        if (activeSelectionSetSelectedIds.has(info.frame_id)) {
          nextSelectedFrames.add(info.frame_id);
        }
      } else {
        nextSelectedFrames.add(info.frame_id);
      }
      nextFrameInfoMap.set(info.frame_id, {
        len: info.max_dlc,
        isExtended: info.is_extended,
        bus: info.bus,
        lenMismatch: info.has_dlc_mismatch,
        protocol,
      });
    }

    set({
      seenIds: nextSeenIds,
      frameInfoMap: nextFrameInfoMap,
      selectedFrames: nextSelectedFrames,
    });
  },
}));
