// ui/src/stores/discoveryFrameStore.ts
//
// Frame picker and selection state for Discovery. The frames themselves live in the
// session's capture; the picker is the capture's inventory, which Rust pushes.

import { create } from 'zustand';
import { tlog } from '../api/settings';
import type { CaptureFrameInfo } from '../api/capture';
import type { FrameMessage } from '../types/frame';
import { frameKey, parseFrameKey } from '../utils/frameKey';
import { selectionSetKeys, type SelectionSet } from '../utils/selectionSets';

/**
 * Picker state for "nothing discovered yet".
 *
 * A factory, not a shared const — these collections are stored in Zustand and compared
 * by reference, so every clear needs its own instances.
 */
function emptyPicker() {
  return {
    frameInfoMap: new Map<string, FrameInfo>(),
    selectedFrames: new Set<string>(),
    seenIds: new Set<string>(),
  };
}

export type FrameInfo = {
  len: number;
  isExtended?: boolean;
  bus?: number;
  lenMismatch?: boolean;
  /** Protocol that produced this frame (e.g. "can", "modbus", "serial"). */
  protocol: string;
};

function toFrameInfo(info: CaptureFrameInfo): FrameInfo {
  return {
    len: info.max_dlc,
    isExtended: info.is_extended,
    bus: info.bus,
    lenMismatch: info.has_dlc_mismatch,
    protocol: info.protocol,
  };
}

function sameFrameInfo(a: FrameInfo | undefined, b: FrameInfo): boolean {
  return !!a && a.len === b.len && a.isExtended === b.isExtended && a.bus === b.bus
    && a.lenMismatch === b.lenMismatch && a.protocol === b.protocol;
}

/** A newly seen key is selected unless an active selection set leaves it out. */
function autoSelects(fk: string, activeSelectionSetSelectedIds: Set<string> | null): boolean {
  return !activeSelectionSetSelectedIds || activeSelectionSetSelectedIds.has(fk);
}

interface DiscoveryFrameState {
  // All Map/Set keys are composite frame keys (e.g. "can:256", "modbus:5013").
  /** Bumped to repaint what reads the capture: a clear, a refresh while frozen, an unfreeze. */
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
  noteStreamStart: (frames: FrameMessage[]) => void;

  // Actions - Data management
  clearAll: () => void;
  mergeFrameInfo: (
    frameInfo: Iterable<CaptureFrameInfo>,
    activeSelectionSetSelectedIds?: Set<string> | null,
    dropped?: string[],
  ) => void;

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
  setFrameInfoFromCapture: (frameInfoList: CaptureFrameInfo[], activeSelectionSetSelectedIds?: Set<string> | null) => void;
}

export const useDiscoveryFrameStore = create<DiscoveryFrameState>((set, get) => ({
  // Initial state
  frameVersion: 0,
  ...emptyPicker(),
  streamStartTimeUs: null,
  captureMode: { enabled: false, totalFrames: 0 },
  renderFrozen: false,

  // Stream timing actions
  setStreamStartTimeUs: (timeUs) => set({ streamStartTimeUs: timeUs }),

  noteStreamStart: (frames) => {
    if (get().streamStartTimeUs !== null || frames.length === 0) return;
    let earliest = frames[0].timestamp_us;
    for (const f of frames) if (f.timestamp_us < earliest) earliest = f.timestamp_us;
    set({ streamStartTimeUs: earliest });
  },

  /**
   * Clear the picker in a single store write.
   *
   * Two store writes mean a render in between where the rows still exist but the
   * picker already reads 0/0.
   */
  clearAll: () => {
    set({
      ...emptyPicker(),
      frameVersion: get().frameVersion + 1,
      streamStartTimeUs: null,
    });
  },

  /**
   * Take a live session's inventory into the picker: rows replace their own keys, and a
   * key seen for the first time is selected as it arrives. What the user deselected,
   * and a selection set's placeholders, stay as they are; `dropped` keys go.
   */
  mergeFrameInfo: (frameInfo, activeSelectionSetSelectedIds = null, dropped = []) => {
    const { frameInfoMap, seenIds, selectedFrames } = get();
    let nextFrameInfoMap: Map<string, FrameInfo> | null = null;
    let nextSeenIds: Set<string> | null = null;
    let nextSelectedFrames: Set<string> | null = null;

    for (const fk of dropped.filter((fk) => seenIds.has(fk))) {
      (nextFrameInfoMap ??= new Map(frameInfoMap)).delete(fk);
      (nextSeenIds ??= new Set(seenIds)).delete(fk);
      (nextSelectedFrames ??= new Set(selectedFrames)).delete(fk);
    }

    for (const row of frameInfo) {
      const fk = frameKey(row.protocol, row.frame_id);
      const info = toFrameInfo(row);
      if (!sameFrameInfo(frameInfoMap.get(fk), info)) {
        (nextFrameInfoMap ??= new Map(frameInfoMap)).set(fk, info);
      }
      if (!seenIds.has(fk)) {
        (nextSeenIds ??= new Set(seenIds)).add(fk);
        if (autoSelects(fk, activeSelectionSetSelectedIds)) {
          (nextSelectedFrames ??= new Set(selectedFrames)).add(fk);
        }
      }
    }

    if (!nextFrameInfoMap && !nextSeenIds) return;
    set({
      ...(nextFrameInfoMap && { frameInfoMap: nextFrameInfoMap }),
      ...(nextSeenIds && { seenIds: nextSeenIds }),
      ...(nextSelectedFrames && { selectedFrames: nextSelectedFrames }),
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

    const { all, selected } = selectionSetKeys(selectionSet, protocol || 'can');
    for (const fk of all) {
      if (!newFrameInfoMap.has(fk)) {
        const { protocol: proto, frameId } = parseFrameKey(fk);
        newFrameInfoMap.set(fk, {
          len: 8,
          isExtended: frameId > 0x7ff,
          bus: undefined,
          lenMismatch: false,
          protocol: proto,
        });
        newSeenIds.add(fk);
      }
    }
    for (const fk of selected) {
      newSelectedFrames.add(fk);
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

  /**
   * One-shot repaint for everything gated on `frameVersion` while frozen — the Filtered
   * tab, the serial views. The frames table is fed by the capture query instead, so the
   * Refresh button drives both.
   */
  refreshFrozenView: () => {
    set({ frameVersion: get().frameVersion + 1 });
  },

  // Capture mode actions
  enableCaptureMode: (totalFrames) => {
    tlog.debug(`[discoveryFrameStore] Enabling capture mode with ${totalFrames} frames`);
    set({
      captureMode: { enabled: true, totalFrames },
      frameVersion: get().frameVersion + 1,
      // Entering capture mode starts a new display clock; the old stream's start is stale.
      streamStartTimeUs: null,
    });
  },

  disableCaptureMode: () => {
    tlog.debug("[discoveryFrameStore] Disabling capture mode");
    set({
      captureMode: { enabled: false, totalFrames: 0 },
    });
  },

  setFrameInfoFromCapture: (frameInfoList, activeSelectionSetSelectedIds = null) => {
    tlog.debug(`[discoveryFrameStore] Setting frame info from capture: ${frameInfoList.length} unique frames`);

    const nextSeenIds = new Set<string>();
    const nextFrameInfoMap = new Map<string, FrameInfo>();
    const nextSelectedFrames = new Set<string>();

    for (const info of frameInfoList) {
      const fk = frameKey(info.protocol, info.frame_id);
      nextSeenIds.add(fk);
      if (autoSelects(fk, activeSelectionSetSelectedIds)) {
        nextSelectedFrames.add(fk);
      }
      nextFrameInfoMap.set(fk, toFrameInfo(info));
    }

    set({
      seenIds: nextSeenIds,
      frameInfoMap: nextFrameInfoMap,
      selectedFrames: nextSelectedFrames,
    });
  },
}));
