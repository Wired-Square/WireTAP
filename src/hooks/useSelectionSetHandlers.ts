// ui/src/hooks/useSelectionSetHandlers.ts
//
// Shared selection set handlers: save, load, clear selection sets.
// Used by Decoder and Discovery via thin app-specific wrappers.

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
  ]);

  // Save new selection set with a name
  const handleSaveNewSelectionSet = useCallback(
    async (name: string) => {
      const allFrameIds = Array.from(frameMap.keys());
      const selectedIds = Array.from(selectedFrames);
      const newSet = await addSelectionSet(name, allFrameIds, selectedIds);
      setActiveSelectionSet(newSet.id);
      setSelectionSetDirty(false);
    },
    [frameMap, selectedFrames, setActiveSelectionSet, setSelectionSetDirty]
  );

  // Load a selection set
  const handleLoadSelectionSet = useCallback(
    async (selectionSet: SelectionSet) => {
      applySelectionSet(selectionSet);
      await markSelectionSetUsed(selectionSet.id);
    },
    [applySelectionSet]
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
