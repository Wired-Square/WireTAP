// ui/src/apps/discovery/hooks/handlers/useDiscoverySelectionHandlers.ts
//
// Selection set handlers for Discovery: save, load, clear selection sets.

import { useCallback } from "react";
import { addSelectionSet, updateSelectionSet, markSelectionSetUsed, type SelectionSet } from "../../../../utils/selectionSets";

export interface UseDiscoverySelectionHandlersParams {
  // State
  frameInfoMap: Map<number, any>;
  selectedFrames: Set<number>;
  activeSelectionSetId: string | null;
  selectionSetDirty: boolean;

  // Store actions
  setActiveSelectionSet: (id: string | null) => void;
  setSelectionSetDirty: (dirty: boolean) => void;
  applySelectionSet: (set: SelectionSet) => void;

  // Dialog controls
  openSaveSelectionSetDialog: () => void;
}

export function useDiscoverySelectionHandlers({
  frameInfoMap,
  selectedFrames,
  activeSelectionSetId,
  selectionSetDirty,
  setActiveSelectionSet,
  setSelectionSetDirty,
  applySelectionSet,
  openSaveSelectionSetDialog,
}: UseDiscoverySelectionHandlersParams) {
  // Handle save selection set
  const handleSaveSelectionSet = useCallback(async () => {
    if (activeSelectionSetId && selectionSetDirty) {
      // Already working with a set - save immediately
      const allFrameIds = Array.from(frameInfoMap.keys());
      const selectedIds = Array.from(selectedFrames);
      await updateSelectionSet(activeSelectionSetId, {
        frameIds: allFrameIds,
        selectedIds: selectedIds,
      });
      setSelectionSetDirty(false);
    } else {
      // No active set - open save dialog
      openSaveSelectionSetDialog();
    }
  }, [activeSelectionSetId, selectionSetDirty, frameInfoMap, selectedFrames, setSelectionSetDirty, openSaveSelectionSetDialog]);

  // Handle save new selection set
  const handleSaveNewSelectionSet = useCallback(async (name: string) => {
    const allFrameIds = Array.from(frameInfoMap.keys());
    const selectedIds = Array.from(selectedFrames);
    const newSet = await addSelectionSet(name, allFrameIds, selectedIds);
    setActiveSelectionSet(newSet.id);
    setSelectionSetDirty(false);
  }, [frameInfoMap, selectedFrames, setActiveSelectionSet, setSelectionSetDirty]);

  // Handle load selection set
  const handleLoadSelectionSet = useCallback(async (selectionSet: SelectionSet) => {
    applySelectionSet(selectionSet);
    await markSelectionSetUsed(selectionSet.id);
  }, [applySelectionSet]);

  // Handle clear selection set
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

export type DiscoverySelectionHandlers = ReturnType<typeof useDiscoverySelectionHandlers>;
