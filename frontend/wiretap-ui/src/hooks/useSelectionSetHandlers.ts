// ui/src/hooks/useSelectionSetHandlers.ts
//
// Shared selection set handlers: save, load, clear selection sets.
// Used by Decoder and Discovery directly.

import { useCallback } from "react";
import { parseFrameKey } from "../utils/frameKey";
import {
  addSelectionSet,
  updateSelectionSet,
  markSelectionSetUsed,
  type SelectionSet,
} from "../utils/selectionSets";

export interface UseSelectionSetHandlersParams {
  /** Map whose keys() yield all known composite frame keys (e.g. "can:256") */
  frameMap: Map<string, unknown>;
  selectedFrames: Set<string>;
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
      await updateSelectionSet(activeSelectionSetId, {
        frameKeys: Array.from(frameMap.keys()),
        selectedKeys: Array.from(selectedFrames),
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
      const newSet = await addSelectionSet(
        name,
        Array.from(frameMap.keys()),
        Array.from(selectedFrames)
      );
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

      // If the frame map holds frames the set does not track, mark dirty so the user
      // can save them into it. A set saved before keys existed only knows numbers, so
      // compare on whichever identity it actually carries.
      const tracked = new Set<string | number>(selectionSet.frameKeys ?? selectionSet.frameIds);
      const identityOf = selectionSet.frameKeys
        ? (fk: string): string | number => fk
        : (fk: string): string | number => parseFrameKey(fk).frameId;
      for (const fk of frameMap.keys()) {
        if (!tracked.has(identityOf(fk))) {
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
