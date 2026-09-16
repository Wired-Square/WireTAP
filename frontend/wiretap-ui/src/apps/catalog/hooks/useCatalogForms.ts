// ui/src/apps/catalog/hooks/useCatalogForms.ts
// Form state management for CatalogEditor

import { useState } from "react";
import type { FrameEditFields } from "../views/FrameEditView";
import { createDefaultFrameFields } from "../views/frameEditUtils";
import type { ProtocolType } from "../types";

export interface SignalFields {
  name: string;
  start_bit: number;
  bit_length: number;
  factor?: number;
  offset?: number;
  unit?: string;
  signed?: boolean;
  endianness?: "little" | "big";
  min?: number;
  max?: number;
  format?: string;
  confidence?: string;
  enum?: Record<string, string>;
  notes?: string;
}

export interface MuxFields {
  name: string;
  start_bit: number;
  bit_length: number;
  notes?: string;
}

const DEFAULT_SIGNAL_FIELDS: SignalFields = {
  name: "",
  start_bit: 0,
  bit_length: 8,
  factor: 1,
  offset: 0,
  unit: "",
  signed: false,
  endianness: undefined,
  min: undefined,
  max: undefined,
  format: undefined,
  confidence: undefined,
  enum: undefined,
};

const DEFAULT_MUX_FIELDS: MuxFields = {
  name: "",
  start_bit: 0,
  bit_length: 8,
};

export function useCatalogForms() {
  // Editing mode flags
  const [editingId, setEditingId] = useState(false);
  const [editingFrameId, setEditingFrameId] = useState<string | null>(null);

  // Signal editing state
  const [editingSignal, setEditingSignal] = useState(false);
  const [signalFields, setSignalFields] = useState<SignalFields>(DEFAULT_SIGNAL_FIELDS);
  const [editingSignalIndex, setEditingSignalIndex] = useState<number | null>(null);
  const [currentIdForSignal, setCurrentIdForSignal] = useState<string | null>(null);
  const [currentSignalPath, setCurrentSignalPath] = useState<string[]>([]);

  // Mux editing state
  const [editingMux, setEditingMux] = useState(false);
  const [isEditingExistingMux, setIsEditingExistingMux] = useState(false);
  const [muxFields, setMuxFields] = useState<MuxFields>(DEFAULT_MUX_FIELDS);
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
    setSignalFields(DEFAULT_SIGNAL_FIELDS);
    setEditingSignalIndex(null);
    setCurrentIdForSignal(null);
    setCurrentSignalPath([]);
    setEditingSignal(false);
  };

  const resetMuxFields = () => {
    setMuxFields(DEFAULT_MUX_FIELDS);
    setCurrentMuxPath([]);
    setIsAddingNestedMux(false);
    setIsEditingExistingMux(false);
    setEditingMux(false);
  };

  return {
    // Frame ID editing
    editingId,
    setEditingId,
    editingFrameId,
    setEditingFrameId,

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
