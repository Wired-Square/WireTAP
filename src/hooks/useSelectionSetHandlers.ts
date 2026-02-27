// ui/src/hooks/useSelectionSetHandlers.ts
//
// Shared selection set handlers: save, load, clear selection sets.
// Used by Decoder and Discovery directly.

import { useCallback } from "react";
import {
  addSelectionSet,
  updateSelectionSet,
  markSelectionSetUsed,
  type SelectionSet,
} from "../utils/selectionSets";

export interface UseSelectionSetHandlersParams {
  /** Map whose keys() yield all known frame IDs */
  frameMap: Map<number, unknown>;
  selectedFrames: Set<number>;
  activeSelectionSetId: string | null;
  selectionSetDirty: boolean;

  // Store actions
  setActiveSelectionSet: (id: string | null) => void;
  setSelectionSetDirty: (dirty: boolean) => void;
  applySelectionSet: (selectionSet: SelectionSet) => void;

  // Dialog controls
  openSaveDialog: () => void;

  /** Called after a selection set is saved or updated (for refreshing lists) */
  onAfterMutate?: () => void;
}

export function useSelectionSetHandlers({
  frameMap,
  selectedFrames,
  activeSelectionSetId,
  selectionSetDirty,
  setActiveSelectionSet,
  setSelectionSetDirty,
  applySelectionSet,
  openSaveDialog,
  onAfterMutate,
}: UseSelectionSetHandlersParams) {
  // Save selection set: update existing if dirty, otherwise open dialog
  const handleSaveSelectionSet = useCallback(async () => {
    if (activeSelectionSetId && selectionSetDirty) {
      const allFrameIds = Array.from(frameMap.keys());
      const selectedIds = Array.from(selectedFrames);
      await updateSelectionSet(activeSelectionSetId, {
        frameIds: allFrameIds,
        selectedIds: selectedIds,
      });
      setSelectionSetDirty(false);
      onAfterMutate?.();
    } else {
      openSaveDialog();
    }
  }, [
    activeSelectionSetId,
    selectionSetDirty,
    frameMap,
    selectedFrames,
    setSelectionSetDirty,
    openSaveDialog,
    onAfterMutate,
  ]);

  // Save new selection set with a name
  const handleSaveNewSelectionSet = useCallback(
    async (name: string) => {
      const allFrameIds = Array.from(frameMap.keys());
      const selectedIds = Array.from(selectedFrames);
      const newSet = await addSelectionSet(name, allFrameIds, selectedIds);
      setActiveSelectionSet(newSet.id);
      setSelectionSetDirty(false);
      onAfterMutate?.();
    },
    [frameMap, selectedFrames, setActiveSelectionSet, setSelectionSetDirty, onAfterMutate]
  );

  // Load a selection set
  const handleLoadSelectionSet = useCallback(
    async (selectionSet: SelectionSet) => {
      applySelectionSet(selectionSet);
      await markSelectionSetUsed(selectionSet.id);

      // If the current frame map has IDs not tracked by the selection set,
      // mark dirty so the user can save those new frames into the set
      const setFrameIds = new Set(selectionSet.frameIds);
      for (const frameId of frameMap.keys()) {
        if (!setFrameIds.has(frameId)) {
          setSelectionSetDirty(true);
          break;
        }
      }
    },
    [applySelectionSet, frameMap, setSelectionSetDirty]
  );

  // Clear current selection set
  const handleClearSelectionSet = useCallback(() => {
    setActiveSelectionSet(null);
    setSelectionSetDirty(false);
  }, [setActiveSelectionSet, setSelectionSetDirty]);

  return {
    handleSaveSelectionSet,
    handleSaveNewSelectionSet,
    handleLoadSelectionSet,
    handleClearSelectionSet,
  };
}

export type SelectionSetHandlers = ReturnType<typeof useSelectionSetHandlers>;
