// ui/src/apps/catalog/hooks/handlers/useSignalHandlers.ts
// Signal and checksum operations for catalog editor

import { useCatalogEditorStore } from "../../../../stores/catalogEditorStore";
import {
  upsertSignalToml,
  deleteSignalToml,
  upsertChecksumToml,
  deleteChecksumToml,
  type ChecksumData,
} from "../../editorOps";
import { validateSignalWs, validateChecksumWs } from "../../../../api/catalog";
import type { SignalFields } from "../../../../types/catalogEdit";
import type { FrameChecksum, Signal } from "../../../../types/catalogModel";
import { NEW_SIGNAL_FIELDS } from "../useCatalogForms";
import { showRefusal } from "./refusal";

export interface UseSignalHandlersParams {
  signalFields: SignalFields;
  currentIdForSignal: string | null;
  currentSignalPath: string[];
  editingSignalIndex: number | null;
  setEditingSignal: (v: boolean) => void;
  setSignalFields: (v: SignalFields) => void;
  setEditingSignalIndex: (v: number | null) => void;
  setCurrentIdForSignal: (v: string | null) => void;
  setCurrentSignalPath: (v: string[]) => void;
}

/** The edit form for a signal as the model holds it. */
export function signalFieldsFor(signal: Signal): SignalFields {
  return {
    name: signal.name ?? "",
    start_bit: signal.startBit ?? 0,
    bit_length: signal.bitLength ?? 0,
    factor: signal.factor,
    offset: signal.offset,
    unit: signal.unit,
    signed: signal.signed,
    byte_order: signal.endianness,
    min: signal.min,
    max: signal.max,
    format: signal.format,
    confidence: signal.confidence,
    enum: signal.enum,
    display: signal.display,
    notes: signal.notes?.join("\n"),
  };
}

export function useSignalHandlers({
  signalFields,
  currentIdForSignal,
  currentSignalPath,
  editingSignalIndex,
  setEditingSignal,
  setSignalFields,
  setEditingSignalIndex,
  setCurrentIdForSignal,
  setCurrentSignalPath,
}: UseSignalHandlersParams) {
  // Store selectors
  const catalogContent = useCatalogEditorStore((s) => s.content.toml);
  const setToml = useCatalogEditorStore((s) => s.setToml);

  const dialogPayload = useCatalogEditorStore((s) => s.ui.dialogPayload);
  const openDialog = useCatalogEditorStore((s) => s.openDialog);
  const closeDialog = useCatalogEditorStore((s) => s.closeDialog);
  const setDialogPayload = useCatalogEditorStore((s) => s.setDialogPayload);

  const setValidation = useCatalogEditorStore((s) => s.setValidation);
  const clearValidation = useCatalogEditorStore((s) => s.clearValidation);
  const setSelectedPath = useCatalogEditorStore((s) => s.setSelectedPath);

  // Signal operations
  const requestDeleteSignal = (
    idKey: string,
    index: number,
    signalsParentPath?: string[],
    signalName?: string
  ) => {
    setDialogPayload({ signalToDelete: { idKey, index, signalsParentPath, name: signalName ?? null } });
    openDialog("deleteSignal");
  };

  const confirmDeleteSignal = () => {
    const signalToDelete = dialogPayload.signalToDelete as
      | { idKey: string; index: number; signalsParentPath?: string[] }
      | null;
    if (!signalToDelete) return;

    handleDeleteSignal(signalToDelete.idKey, signalToDelete.index, signalToDelete.signalsParentPath);
    closeDialog("deleteSignal");
    setDialogPayload({ signalToDelete: null });
  };

  const handleAddSignal = (idKey: string, signalPath?: string[]) => {
    setCurrentIdForSignal(idKey);
    setCurrentSignalPath(signalPath || ["frame", "can", idKey]);
    setEditingSignalIndex(null);
    setSignalFields(NEW_SIGNAL_FIELDS);
    setEditingSignal(true);
  };

  const handleEditSignal = (idKey: string, signalIndex: number, signal: Signal, signalsParentPath?: string[]) => {
    setCurrentIdForSignal(idKey);
    const parentPath = signalsParentPath || ["frame", "can", idKey];
    setCurrentSignalPath(parentPath);
    setEditingSignalIndex(signalIndex);
    setSignalFields(signalFieldsFor(signal));
    setEditingSignal(true);
  };

  const handleSaveSignal = async () => {
    if (!currentIdForSignal) return;

    const errors = await validateSignalWs({ ...signalFields, endianness: signalFields.byte_order });
    if (errors.length > 0) {
      setValidation(errors);
      return;
    }

    try {
      const newContent = await upsertSignalToml(catalogContent, currentSignalPath, signalFields, editingSignalIndex);
      setToml(newContent);
      setEditingSignal(false);
      clearValidation();
    } catch (error) {
      showRefusal("signal", error);
    }
  };

  const handleDeleteSignal = async (idKey: string, signalIndex: number, signalsParentPath?: string[]) => {
    try {
      const parent = signalsParentPath ?? ["frame", "can", idKey];
      const newContent = await deleteSignalToml(catalogContent, parent, signalIndex);
      setToml(newContent);
    } catch (error) {
      console.error("Failed to delete signal:", error);
      setValidation([{ field: "signal", message: "Failed to delete signal" }]);
    }
  };

  // Checksum operations
  const handleEditChecksum = (idKey: string, checksumIndex: number, checksum: FrameChecksum, checksumsParentPath?: string[]) => {
    setDialogPayload({
      checksumToEdit: {
        idKey,
        index: checksumIndex,
        checksum: {
          name: checksum.name ?? "",
          algorithm: checksum.algorithm,
          start_byte: checksum.startByte,
          byte_length: checksum.byteLength,
          endianness: checksum.endianness,
          calc_start_byte: checksum.calcStartByte,
          calc_end_byte: checksum.calcEndByte,
          notes: checksum.notes?.join("\n"),
        },
        checksumsParentPath: checksumsParentPath || ["frame", "can", idKey],
      },
    });
    openDialog("editChecksum");
  };

  const handleSaveChecksum = async (checksumData: ChecksumData, checksumsParentPath: string[], editingIndex: number | null) => {
    const errors = await validateChecksumWs(checksumData);
    if (errors.length > 0) {
      setValidation(errors);
      return;
    }

    try {
      const newContent = await upsertChecksumToml(catalogContent, checksumsParentPath, checksumData, editingIndex);
      setToml(newContent);
      closeDialog("editChecksum");
      clearValidation();
    } catch (error) {
      console.error("Failed to save checksum:", error);
      setValidation([{ field: "checksum", message: "Failed to save checksum" }]);
    }
  };

  const requestDeleteChecksum = (
    idKey: string,
    index: number,
    checksumsParentPath?: string[],
    checksumName?: string
  ) => {
    setDialogPayload({
      checksumToDelete: {
        idKey,
        index,
        checksumsParentPath: checksumsParentPath || ["frame", "can", idKey],
        name: checksumName ?? null,
      },
    });
    openDialog("deleteChecksum");
  };

  const confirmDeleteChecksum = async () => {
    const checksumToDelete = dialogPayload.checksumToDelete as
      | { idKey: string; index: number; checksumsParentPath: string[] }
      | null;
    if (!checksumToDelete) return;

    try {
      const newContent = await deleteChecksumToml(
        catalogContent,
        checksumToDelete.checksumsParentPath,
        checksumToDelete.index
      );
      setToml(newContent);
      setSelectedPath(null);
    } catch (error) {
      console.error("Failed to delete checksum:", error);
      setValidation([{ field: "checksum", message: "Failed to delete checksum" }]);
    } finally {
      closeDialog("deleteChecksum");
      setDialogPayload({ checksumToDelete: null });
    }
  };

  return {
    // Signal operations
    requestDeleteSignal,
    confirmDeleteSignal,
    handleAddSignal,
    handleEditSignal,
    handleSaveSignal,
    handleDeleteSignal,

    // Checksum operations
    handleEditChecksum,
    handleSaveChecksum,
    requestDeleteChecksum,
    confirmDeleteChecksum,
  };
}
