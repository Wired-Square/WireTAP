// ui/src/stores/discoveryFrameStore.ts
//
// Frame data and selection state for Discovery app.
// Handles frame buffer, frame info map, and selection.

import { create } from 'zustand';
import { tlog } from '../api/settings';
import type { FrameMessage } from '../types/frame';
import type { SelectionSet } from '../utils/selectionSets';

// Frame buffer for throttling UI updates
let pendingFrames: FrameMessage[] = [];
let flushTimeout: ReturnType<typeof setTimeout> | null = null;
const FLUSH_INTERVAL_MS = 40;
// Allow the frame buffer to temporarily overshoot maxBuffer by this many frames
// before compacting. This avoids O(100k) splice every 40ms — compaction happens
// once every few minutes instead of 25x/sec, dramatically reducing GC pressure.
const COMPACT_THRESHOLD = 10_000;

// Mutable frame buffer — avoids creating a new 100k-element array on every
// 40ms flush, which caused JSC GC pressure that froze the main thread after
// ~30 min of streaming. Components subscribe to `frameVersion` for reactivity
// and read from this buffer via `getDiscoveryFrameBuffer()`.
let _frameBuffer: FrameMessage[] = [];

/** Direct access to the mutable frame buffer. Read-only. */
export function getDiscoveryFrameBuffer(): FrameMessage[] {
  return _frameBuffer;
}

export type FrameInfo = {
  len: number;
  isExtended?: boolean;
  bus?: number;
  lenMismatch?: boolean;
  protocol?: string;
};

interface DiscoveryFrameState {
  // Frame data (actual frames live in _frameBuffer, not in state — see module comment)
  frameVersion: number;
  frameInfoMap: Map<number, FrameInfo>;
  selectedFrames: Set<number>;
  seenIds: Set<number>;

  // Stream timing
  streamStartTimeUs: number | null;

  // Buffer mode (for large datasets)
  bufferMode: {
    enabled: boolean;
    totalFrames: number;
  };

  // Actions - Stream timing
  setStreamStartTimeUs: (timeUs: number | null) => void;

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
  frameVersion: 0,
  frameInfoMap: new Map(),
  selectedFrames: new Set(),
  seenIds: new Set(),
  streamStartTimeUs: null,
  bufferMode: { enabled: false, totalFrames: 0 },

  // Stream timing actions
  setStreamStartTimeUs: (timeUs) => set({ streamStartTimeUs: timeUs }),

  // Data management actions
  addFrames: (newFrames, maxBuffer, skipFramePicker = false, activeSelectionSetSelectedIds = null) => {
    pendingFrames.push(...newFrames);

    if (flushTimeout === null) {
      flushTimeout = setTimeout(() => {
        flushTimeout = null;
        const framesToProcess = pendingFrames;
        pendingFrames = [];

        if (framesToProcess.length === 0) return;

        const { frameInfoMap, seenIds, selectedFrames, streamStartTimeUs, frameVersion } = get();

        if (streamStartTimeUs === null && framesToProcess.length > 0) {
          // Use a loop instead of Math.min(...spread) to avoid stack overflow
          // risk if a large batch accumulates during a GC pause
          let earliestTs = framesToProcess[0].timestamp_us;
          for (let i = 1; i < framesToProcess.length; i++) {
            if (framesToProcess[i].timestamp_us < earliestTs) {
              earliestTs = framesToProcess[i].timestamp_us;
            }
          }
          set({ streamStartTimeUs: earliestTs });
        }

        // Mutate buffer in place — avoids creating a new 100k array every flush.
        // Only compact when overshooting by COMPACT_THRESHOLD instead of splicing
        // every flush. This avoids O(100k) element shifts 25x/sec.
        _frameBuffer.push(...framesToProcess);
        if (_frameBuffer.length > maxBuffer + COMPACT_THRESHOLD) {
          _frameBuffer = _frameBuffer.slice(-maxBuffer);
        }

        const stateUpdate: Partial<DiscoveryFrameState> = { frameVersion: frameVersion + 1 };

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
    _frameBuffer = [];
    if (flushTimeout !== null) {
      clearTimeout(flushTimeout);
      flushTimeout = null;
    }
    set({ frameVersion: get().frameVersion + 1, streamStartTimeUs: null });
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
    _frameBuffer = [];
    if (flushTimeout !== null) {
      clearTimeout(flushTimeout);
      flushTimeout = null;
    }
    set({
      frameVersion: get().frameVersion + 1,
      frameInfoMap: new Map(),
      selectedFrames: new Set(),
      seenIds: new Set(),
      streamStartTimeUs: null,
    });
  },

  setFrames: (frames) => {
    _frameBuffer = frames;
    set({ frameVersion: get().frameVersion + 1 });
    get().rebuildFramePickerFromBuffer();
  },

  rebuildFramePickerFromBuffer: (activeSelectionSetSelectedIds = null) => {
    const frames = _frameBuffer;
    if (frames.length === 0) return;

    tlog.debug(`[discoveryFrameStore] Building frame picker from ${frames.length} frames`);

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

    tlog.debug(`[discoveryFrameStore] Found ${nextSeenIds.size} unique frame IDs`);

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
    tlog.debug(`[discoveryFrameStore] Enabling buffer mode with ${totalFrames} frames`);
    _frameBuffer = [];
    set({
      bufferMode: { enabled: true, totalFrames },
      frameVersion: get().frameVersion + 1,
    });
  },

  disableBufferMode: () => {
    tlog.debug("[discoveryFrameStore] Disabling buffer mode");
    set({
      bufferMode: { enabled: false, totalFrames: 0 },
    });
  },

  setFrameInfoFromBuffer: (frameInfoList, protocol, activeSelectionSetSelectedIds = null) => {
    tlog.debug(`[discoveryFrameStore] Setting frame info from buffer: ${frameInfoList.length} unique frames, protocol: ${protocol || 'can'}`);

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
