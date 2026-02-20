// ui/src/apps/discovery/hooks/handlers/useDiscoverySelectionHandlers.ts
//
// Selection set handlers for Discovery: thin wrapper around shared hook.

import { useSelectionSetHandlers } from "../../../../hooks/useSelectionSetHandlers";
import type { SelectionSet } from "../../../../utils/selectionSets";

export interface UseDiscoverySelectionHandlersParams {
  // State
  frameInfoMap: Map<number, unknown>;
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
  return useSelectionSetHandlers({
    frameMap: frameInfoMap,
    selectedFrames,
    activeSelectionSetId,
    selectionSetDirty,
    setActiveSelectionSet,
    setSelectionSetDirty,
    applySelectionSet,
    openSaveDialog: openSaveSelectionSetDialog,
  });
}

export type DiscoverySelectionHandlers = ReturnType<typeof useDiscoverySelectionHandlers>;
