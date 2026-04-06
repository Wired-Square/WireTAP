// ui/src/stores/discoveryFrameStore.ts
//
// Frame data and selection state for Discovery app.
// Handles frame buffer, frame info map, and selection.

import { create } from 'zustand';
import { tlog } from '../api/settings';
import { trackAlloc } from '../services/memoryDiag';
import type { FrameMessage } from '../types/frame';
import { keyOf } from '../utils/frameKey';
import type { SelectionSet } from '../utils/selectionSets';

// Frame buffer for throttling UI updates
let pendingFrames: FrameMessage[] = [];
let flushTimeout: ReturnType<typeof setTimeout> | null = null;
// 500ms (2Hz) — fast enough for human perception, avoids overwhelming GC with
// transient object allocations from Zustand selectors and React reconciliation.
const FLUSH_INTERVAL_MS = 500;
// Allow the frame buffer to temporarily overshoot maxBuffer by this many frames
// before compacting. This avoids O(100k) splice every flush — compaction happens
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

export type LastFrameData = {
  bytes: number[];
  bus: number;
  is_extended: boolean;
  dlc: number;
};

// Last observed frame data per frame ID — updated on every flush (last-writer-wins).
// Used by bulk-add to Transmit queue so we don't need to scan the full buffer at click time.
// Keyed by composite frame key (e.g. "can:256", "modbus:5013").
let _lastFrameDataMap: Map<string, LastFrameData> = new Map();

/** Direct access to the last-seen frame data map (keyed by composite frame key). Read-only. */
export function getLastFrameDataMap(): Map<string, LastFrameData> {
  return _lastFrameDataMap;
}

export type FrameInfo = {
  len: number;
  isExtended?: boolean;
  bus?: number;
  lenMismatch?: boolean;
  /** Protocol that produced this frame (e.g. "can", "modbus", "serial"). */
  protocol: string;
};

interface DiscoveryFrameState {
  // Frame data (actual frames live in _frameBuffer, not in state — see module comment)
  // All Map/Set keys are composite frame keys (e.g. "can:256", "modbus:5013").
  frameVersion: number;
  frameInfoMap: Map<string, FrameInfo>;
  selectedFrames: Set<string>;
  seenIds: Set<string>;

  // Stream timing
  streamStartTimeUs: number | null;

  // Capture mode (for large datasets)
  captureMode: {
    enabled: boolean;
    totalFrames: number;
  };

  // Actions - Stream timing
  setStreamStartTimeUs: (timeUs: number | null) => void;

  // Actions - Data management
  addFrames: (newFrames: FrameMessage[], maxBuffer: number, skipFramePicker?: boolean, activeSelectionSetSelectedIds?: Set<string> | null) => void;
  clearBuffer: () => void;
  clearFramePicker: () => void;
  clearAll: () => void;
  setFrames: (frames: FrameMessage[]) => void;
  rebuildFramePickerFromBuffer: (activeSelectionSetSelectedIds?: Set<string> | null) => void;

  // Actions - Frame selection
  toggleFrameSelection: (id: string, activeSelectionSetId: string | null, setDirty: (dirty: boolean) => void) => void;
  bulkSelectBus: (bus: number | null, select: boolean, activeSelectionSetId: string | null, setDirty: (dirty: boolean) => void) => void;
  selectAllFrames: (activeSelectionSetId: string | null, setDirty: (dirty: boolean) => void) => void;
  deselectAllFrames: (activeSelectionSetId: string | null, setDirty: (dirty: boolean) => void) => void;
  applySelectionSet: (selectionSet: SelectionSet, protocol: string, setActiveId: (id: string | null) => void, setDirty: (dirty: boolean) => void) => void;

  // Actions - Render freeze (pause UI updates while capture continues)
  renderFrozen: boolean;
  setRenderFrozen: (frozen: boolean) => void;
  refreshFrozenView: () => void;

  // Actions - Capture mode
  enableCaptureMode: (totalFrames: number) => void;
  disableCaptureMode: () => void;
  setFrameInfoFromCapture: (frameInfoList: Array<{
    frame_id: number;
    max_dlc: number;
    bus: number;
    is_extended: boolean;
    has_dlc_mismatch: boolean;
  }>, protocol?: string, activeSelectionSetSelectedIds?: Set<string> | null) => void;
}

export const useDiscoveryFrameStore = create<DiscoveryFrameState>((set, get) => ({
  // Initial state
  frameVersion: 0,
  frameInfoMap: new Map(),
  selectedFrames: new Set(),
  seenIds: new Set(),
  streamStartTimeUs: null,
  captureMode: { enabled: false, totalFrames: 0 },
  renderFrozen: false,

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
        try {

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
        trackAlloc("frameBuffer.push", framesToProcess.length * 300);
        trackAlloc("frameBuffer.size", _frameBuffer.length * 300);
        if (_frameBuffer.length > maxBuffer + COMPACT_THRESHOLD) {
          _frameBuffer = _frameBuffer.slice(-maxBuffer);
        }

        // Keep last-seen data per frame ID (last-writer-wins, no allocation overhead)
        for (const f of framesToProcess) {
          _lastFrameDataMap.set(keyOf(f), {
            bytes: f.bytes,
            bus: f.bus ?? 0,
            is_extended: f.is_extended ?? false,
            dlc: f.dlc,
          });
        }

        const stateUpdate: Partial<DiscoveryFrameState> = {
          frameVersion: get().renderFrozen ? frameVersion : frameVersion + 1,
        };

        // Skip frame picker updates if requested (e.g., serial mode before framing is accepted)
        if (!skipFramePicker) {
          const newlyDiscovered: string[] = [];
          for (const f of framesToProcess) {
            const fk = keyOf(f);
            if (!seenIds.has(fk)) {
              newlyDiscovered.push(fk);
            }
          }

          if (newlyDiscovered.length > 0) {
            const nextSeenIds = new Set(seenIds);
            const nextSelectedFrames = new Set(selectedFrames);
            newlyDiscovered.forEach((fk) => {
              nextSeenIds.add(fk);
              // When a selection set is active, only auto-select frames that are in the set
              if (activeSelectionSetSelectedIds) {
                if (activeSelectionSetSelectedIds.has(fk)) {
                  nextSelectedFrames.add(fk);
                }
              } else {
                nextSelectedFrames.add(fk);
              }
            });
            trackAlloc("frameStore.newSet", nextSeenIds.size * 60);
            stateUpdate.seenIds = nextSeenIds;
            stateUpdate.selectedFrames = nextSelectedFrames;
          }

          // Update frame info map
          let frameInfoChanged = newlyDiscovered.length > 0;

          if (!frameInfoChanged) {
            for (const f of framesToProcess) {
              const current = frameInfoMap.get(keyOf(f));
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
              const fk = keyOf(f);
              const current = nextFrameInfoMap.get(fk);
              const newLen = current ? Math.max(current.len, f.dlc) : f.dlc;
              const newBus = current?.bus ?? f.bus;
              const newExtended = current?.isExtended ?? f.is_extended;
              const lenMismatch = current ? current.lenMismatch || current.len !== f.dlc : false;
              const protocol = current?.protocol ?? f.protocol ?? 'can';

              if (
                !current ||
                current.len !== newLen ||
                current.isExtended !== newExtended ||
                current.bus !== newBus ||
                current.lenMismatch !== lenMismatch ||
                current.protocol !== protocol
              ) {
                nextFrameInfoMap.set(fk, { len: newLen, isExtended: newExtended, bus: newBus, lenMismatch, protocol });
              }
            }

            trackAlloc("frameStore.newMap", nextFrameInfoMap.size * 100);
            stateUpdate.frameInfoMap = nextFrameInfoMap;
          }
        }

        set(stateUpdate);
        } catch (e) {
          console.error('[discoveryFrameStore] flush error:', e);
        }
      }, FLUSH_INTERVAL_MS);
    }
  },

  clearBuffer: () => {
    pendingFrames = [];
    _frameBuffer = [];
    _lastFrameDataMap = new Map();
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
    _lastFrameDataMap = new Map();
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

    const nextSeenIds = new Set<string>();
    const nextFrameInfoMap = new Map<string, FrameInfo>();
    const nextSelectedFrames = new Set<string>();
    _lastFrameDataMap = new Map();

    for (const f of frames) {
      const fk = keyOf(f);
      // Rebuild last-seen data map (last-writer-wins as we iterate forward)
      _lastFrameDataMap.set(fk, {
        bytes: f.bytes,
        bus: f.bus ?? 0,
        is_extended: f.is_extended ?? false,
        dlc: f.dlc,
      });
      if (!nextSeenIds.has(fk)) {
        nextSeenIds.add(fk);
        if (activeSelectionSetSelectedIds) {
          if (activeSelectionSetSelectedIds.has(fk)) {
            nextSelectedFrames.add(fk);
          }
        } else {
          nextSelectedFrames.add(fk);
        }
      }

      const current = nextFrameInfoMap.get(fk);
      const newLen = current ? Math.max(current.len, f.dlc) : f.dlc;
      const newBus = current?.bus ?? f.bus;
      const newExtended = current?.isExtended ?? f.is_extended;
      const lenMismatch = current ? current.lenMismatch || current.len !== f.dlc : false;
      const protocol = current?.protocol ?? f.protocol ?? 'can';

      if (
        !current ||
        current.len !== newLen ||
        current.isExtended !== newExtended ||
        current.bus !== newBus ||
        current.lenMismatch !== lenMismatch ||
        current.protocol !== protocol
      ) {
        nextFrameInfoMap.set(fk, { len: newLen, isExtended: newExtended, bus: newBus, lenMismatch, protocol });
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

  applySelectionSet: (selectionSet, protocol, setActiveId, setDirty) => {
    const { frameInfoMap, seenIds } = get();

    const newFrameInfoMap = new Map(frameInfoMap);
    const newSeenIds = new Set(seenIds);
    const newSelectedFrames = new Set<string>();

    // Selection sets store numeric IDs — convert to composite keys using the session's protocol
    const proto = protocol || 'can';
    for (const numericId of selectionSet.frameIds) {
      const fk = `${proto}:${numericId}`;
      if (!newFrameInfoMap.has(fk)) {
        newFrameInfoMap.set(fk, {
          len: 8,
          isExtended: numericId > 0x7ff,
          bus: undefined,
          lenMismatch: false,
          protocol: proto,
        });
        newSeenIds.add(fk);
      }
    }

    const idsToSelect = selectionSet.selectedIds ?? selectionSet.frameIds;
    for (const numericId of idsToSelect) {
      newSelectedFrames.add(`${proto}:${numericId}`);
    }

    set({
      frameInfoMap: newFrameInfoMap,
      seenIds: newSeenIds,
      selectedFrames: newSelectedFrames,
    });
    setActiveId(selectionSet.id);
    setDirty(false);
  },

  // Render freeze actions
  setRenderFrozen: (frozen) => {
    if (frozen) {
      set({ renderFrozen: true });
    } else {
      // Unfreeze and bump frameVersion to immediately show latest data
      set({ renderFrozen: false, frameVersion: get().frameVersion + 1 });
    }
  },

  refreshFrozenView: () => {
    // One-shot render: bump frameVersion without changing renderFrozen
    set({ frameVersion: get().frameVersion + 1 });
  },

  // Capture mode actions
  enableCaptureMode: (totalFrames) => {
    tlog.debug(`[discoveryFrameStore] Enabling capture mode with ${totalFrames} frames`);
    _frameBuffer = [];
    set({
      captureMode: { enabled: true, totalFrames },
      frameVersion: get().frameVersion + 1,
    });
  },

  disableCaptureMode: () => {
    tlog.debug("[discoveryFrameStore] Disabling capture mode");
    set({
      captureMode: { enabled: false, totalFrames: 0 },
    });
  },

  setFrameInfoFromCapture: (frameInfoList, protocol, activeSelectionSetSelectedIds = null) => {
    const proto = protocol || 'can';
    tlog.debug(`[discoveryFrameStore] Setting frame info from capture: ${frameInfoList.length} unique frames, protocol: ${proto}`);

    const nextSeenIds = new Set<string>();
    const nextFrameInfoMap = new Map<string, FrameInfo>();
    const nextSelectedFrames = new Set<string>();

    for (const info of frameInfoList) {
      const fk = `${proto}:${info.frame_id}`;
      nextSeenIds.add(fk);
      if (activeSelectionSetSelectedIds) {
        if (activeSelectionSetSelectedIds.has(fk)) {
          nextSelectedFrames.add(fk);
        }
      } else {
        nextSelectedFrames.add(fk);
      }
      nextFrameInfoMap.set(fk, {
        len: info.max_dlc,
        isExtended: info.is_extended,
        bus: info.bus,
        lenMismatch: info.has_dlc_mismatch,
        protocol: proto,
      });
    }

    set({
      seenIds: nextSeenIds,
      frameInfoMap: nextFrameInfoMap,
      selectedFrames: nextSelectedFrames,
    });
  },
}));
