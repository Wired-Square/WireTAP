// ui/src/apps/decoder/hooks/handlers/useDecoderSelectionHandlers.ts
//
// Selection set handlers for Decoder: save, load, clear selection sets.

import { useCallback } from "react";
import {
  addSelectionSet,
  updateSelectionSet,
  markSelectionSetUsed,
  type SelectionSet,
} from "../../../../utils/selectionSets";
import type { FrameDetail } from "../../../../types/decoder";

export interface UseDecoderSelectionHandlersParams {
  // Store state
  frames: Map<number, FrameDetail>;
  selectedFrames: Set<number>;
  activeSelectionSetId: string | null;
  selectionSetDirty: boolean;

  // Store actions
  setActiveSelectionSet: (id: string | null) => void;
  setSelectionSetDirty: (dirty: boolean) => void;
  applySelectionSet: (selectionSet: SelectionSet) => void;

  // Dialog controls
  openSaveSelectionSet: () => void;
}

export function useDecoderSelectionHandlers({
  frames,
  selectedFrames,
  activeSelectionSetId,
  selectionSetDirty,
  setActiveSelectionSet,
  setSelectionSetDirty,
  applySelectionSet,
  openSaveSelectionSet,
}: UseDecoderSelectionHandlersParams) {
  // Save selection set handler
  const handleSaveSelectionSet = useCallback(async () => {
    if (activeSelectionSetId && selectionSetDirty) {
      // Already working with a set - save immediately
      // In Decoder, frameIds = all frame IDs from catalog, selectedIds = those that are selected
      const allFrameIds = Array.from(frames.keys());
      const selectedIds = Array.from(selectedFrames);
      await updateSelectionSet(activeSelectionSetId, {
        frameIds: allFrameIds,
        selectedIds: selectedIds,
      });
      setSelectionSetDirty(false);
    } else {
      // No active set - open save dialog
      openSaveSelectionSet();
    }
  }, [
    activeSelectionSetId,
    selectionSetDirty,
    frames,
    selectedFrames,
    setSelectionSetDirty,
    openSaveSelectionSet,
  ]);

  // Save new selection set with a name
  const handleSaveNewSelectionSet = useCallback(
    async (name: string) => {
      // In Decoder, frameIds = all frame IDs from catalog, selectedIds = those that are selected
      const allFrameIds = Array.from(frames.keys());
      const selectedIds = Array.from(selectedFrames);
      const newSet = await addSelectionSet(name, allFrameIds, selectedIds);
      setActiveSelectionSet(newSet.id);
      setSelectionSetDirty(false);
    },
    [frames, selectedFrames, setActiveSelectionSet, setSelectionSetDirty]
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

export type DecoderSelectionHandlers = ReturnType<typeof useDecoderSelectionHandlers>;
