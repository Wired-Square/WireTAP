// ui/src/apps/catalog/hooks/useCatalogHandlers.ts
// Orchestrator hook that combines domain-specific handlers

import { useFileHandlers } from "./handlers/useFileHandlers";
import { useSignalHandlers } from "./handlers/useSignalHandlers";
import { useMuxHandlers } from "./handlers/useMuxHandlers";
import { useFrameHandlers } from "./handlers/useFrameHandlers";
import type { SignalFields, MuxFields } from "./useCatalogForms";
import type { FrameEditFields } from "../views/FrameEditView";
import type { AppSettings } from "../../../hooks/useSettings";

export type CatalogHandlers = ReturnType<typeof useCatalogHandlers>;

export interface UseCatalogHandlersParams {
  // Settings
  settings: AppSettings | null | undefined;
  saveFrameIdFormat: "hex" | "decimal";

  // Signal editing state
  signalFields: SignalFields;
  currentIdForSignal: string | null;
  currentSignalPath: string[];
  editingSignalIndex: number | null;
  setEditingSignal: (v: boolean) => void;
  setSignalFields: (v: SignalFields) => void;
  setEditingSignalIndex: (v: number | null) => void;
  setCurrentIdForSignal: (v: string | null) => void;
  setCurrentSignalPath: (v: string[]) => void;

  // Mux editing state
  muxFields: MuxFields;
  currentMuxPath: string[];
  isEditingExistingMux: boolean;
  setEditingMux: (v: boolean) => void;
  setMuxFields: (v: MuxFields) => void;
  setCurrentMuxPath: (v: string[]) => void;
  setIsAddingNestedMux: (v: boolean) => void;
  setIsEditingExistingMux: (v: boolean) => void;

  // CAN frame editing (legacy)
  editingFrameId: string | null;
  setEditingId: (v: boolean) => void;
  setEditingFrameId: (v: string | null) => void;

  // Generic frame editing
  frameFields?: FrameEditFields;
  editingFrameOriginalKey?: string | null;
  setEditingFrame?: (v: boolean) => void;
  setFrameFields?: (v: FrameEditFields) => void;
  setEditingFrameOriginalKey?: (v: string | null) => void;
}

export function useCatalogHandlers(params: UseCatalogHandlersParams) {
  // File operations (file I/O, meta, validation, unsaved changes)
  const fileHandlers = useFileHandlers({
    settings: params.settings,
    saveFrameIdFormat: params.saveFrameIdFormat,
  });

  // Signal and checksum operations
  const signalHandlers = useSignalHandlers({
    signalFields: params.signalFields,
    currentIdForSignal: params.currentIdForSignal,
    currentSignalPath: params.currentSignalPath,
    editingSignalIndex: params.editingSignalIndex,
    setEditingSignal: params.setEditingSignal,
    setSignalFields: params.setSignalFields,
    setEditingSignalIndex: params.setEditingSignalIndex,
    setCurrentIdForSignal: params.setCurrentIdForSignal,
    setCurrentSignalPath: params.setCurrentSignalPath,
  });

  // Mux and case operations
  const muxHandlers = useMuxHandlers({
    muxFields: params.muxFields,
    currentMuxPath: params.currentMuxPath,
    isEditingExistingMux: params.isEditingExistingMux,
    setEditingMux: params.setEditingMux,
    setMuxFields: params.setMuxFields,
    setCurrentMuxPath: params.setCurrentMuxPath,
    setIsAddingNestedMux: params.setIsAddingNestedMux,
    setIsEditingExistingMux: params.setIsEditingExistingMux,
  });

  // Frame, node, and config operations
  const frameHandlers = useFrameHandlers({
    editingFrameId: params.editingFrameId,
    setEditingId: params.setEditingId,
    setEditingFrameId: params.setEditingFrameId,
    frameFields: params.frameFields,
    editingFrameOriginalKey: params.editingFrameOriginalKey,
    setEditingFrame: params.setEditingFrame,
    setFrameFields: params.setFrameFields,
    setEditingFrameOriginalKey: params.setEditingFrameOriginalKey,
  });

  return {
    // File operations
    ...fileHandlers,

    // Signal operations
    ...signalHandlers,

    // Mux operations
    ...muxHandlers,

    // Frame, node, and config operations
    ...frameHandlers,
  };
}
