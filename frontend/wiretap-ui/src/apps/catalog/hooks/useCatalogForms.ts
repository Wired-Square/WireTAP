// ui/src/apps/catalog/hooks/useCatalogForms.ts
// Form state management for CatalogEditor

import { useState } from "react";
import type { FrameEditFields } from "../views/FrameEditView";
import { createDefaultFrameFields } from "../views/frameEditUtils";
import type { ProtocolType } from "../types";
import type { MuxFields, SignalFields } from "../../../types/catalogEdit";

export const NEW_SIGNAL_FIELDS: SignalFields = {
  name: "",
  start_bit: 0,
  bit_length: 8,
  factor: 1,
  offset: 0,
  unit: "",
  signed: false,
};

export const NEW_MUX_FIELDS: MuxFields = { name: "", start_bit: 0, bit_length: 8 };

export function useCatalogForms() {
  // Signal editing state
  const [editingSignal, setEditingSignal] = useState(false);
  const [signalFields, setSignalFields] = useState<SignalFields>(NEW_SIGNAL_FIELDS);
  const [editingSignalIndex, setEditingSignalIndex] = useState<number | null>(null);
  const [currentIdForSignal, setCurrentIdForSignal] = useState<string | null>(null);
  const [currentSignalPath, setCurrentSignalPath] = useState<string[]>([]);

  // Mux editing state
  const [editingMux, setEditingMux] = useState(false);
  const [isEditingExistingMux, setIsEditingExistingMux] = useState(false);
  const [muxFields, setMuxFields] = useState<MuxFields>(NEW_MUX_FIELDS);
  const [currentMuxPath, setCurrentMuxPath] = useState<string[]>([]);
  const [isAddingNestedMux, setIsAddingNestedMux] = useState(false);

  // Export dialog
  const [showExportDialog, setShowExportDialog] = useState(false);

  // Generic frame editing state
  const [editingFrame, setEditingFrame] = useState(false);
  const [frameFields, setFrameFields] = useState<FrameEditFields>(() => createDefaultFrameFields("can"));
  const [editingFrameOriginalKey, setEditingFrameOriginalKey] = useState<string | null>(null);

  const resetFrameFields = (protocol: ProtocolType = "can") => {
    setFrameFields(createDefaultFrameFields(protocol));
    setEditingFrameOriginalKey(null);
    setEditingFrame(false);
  };

  const resetSignalFields = () => {
    setSignalFields(NEW_SIGNAL_FIELDS);
    setEditingSignalIndex(null);
    setCurrentIdForSignal(null);
    setCurrentSignalPath([]);
    setEditingSignal(false);
  };

  const resetMuxFields = () => {
    setMuxFields(NEW_MUX_FIELDS);
    setCurrentMuxPath([]);
    setIsAddingNestedMux(false);
    setIsEditingExistingMux(false);
    setEditingMux(false);
  };

  return {
    // Signal editing
    editingSignal,
    setEditingSignal,
    signalFields,
    setSignalFields,
    editingSignalIndex,
    setEditingSignalIndex,
    currentIdForSignal,
    setCurrentIdForSignal,
    currentSignalPath,
    setCurrentSignalPath,
    resetSignalFields,

    // Mux editing
    editingMux,
    setEditingMux,
    isEditingExistingMux,
    setIsEditingExistingMux,
    muxFields,
    setMuxFields,
    currentMuxPath,
    setCurrentMuxPath,
    isAddingNestedMux,
    setIsAddingNestedMux,
    resetMuxFields,

    // Export dialog
    showExportDialog,
    setShowExportDialog,

    // Generic frame editing
    editingFrame,
    setEditingFrame,
    frameFields,
    setFrameFields,
    editingFrameOriginalKey,
    setEditingFrameOriginalKey,
    resetFrameFields,
  };
}
