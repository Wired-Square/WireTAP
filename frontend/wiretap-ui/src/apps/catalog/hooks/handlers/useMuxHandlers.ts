// ui/src/apps/catalog/hooks/handlers/useMuxHandlers.ts
// Mux and mux case operations for catalog editor

import { useCatalogEditorStore } from "../../../../stores/catalogEditorStore";
import {
  upsertMuxToml,
  deleteMuxToml,
  addMuxCaseToml,
  editMuxCaseToml,
  deleteMuxCaseToml,
} from "../../editorOps";
import type { MuxFields } from "../../../../types/catalogEdit";
import type { Mux } from "../../../../types/catalogModel";
import { showRefusal } from "./refusal";
import { NEW_MUX_FIELDS } from "../useCatalogForms";

export interface UseMuxHandlersParams {
  muxFields: MuxFields;
  currentMuxPath: string[];
  isEditingExistingMux: boolean;
  setEditingMux: (v: boolean) => void;
  setMuxFields: (v: MuxFields) => void;
  setCurrentMuxPath: (v: string[]) => void;
  setIsAddingNestedMux: (v: boolean) => void;
  setIsEditingExistingMux: (v: boolean) => void;
}

export function useMuxHandlers({
  muxFields,
  currentMuxPath,
  isEditingExistingMux,
  setEditingMux,
  setMuxFields,
  setCurrentMuxPath,
  setIsAddingNestedMux,
  setIsEditingExistingMux,
}: UseMuxHandlersParams) {
  // Store selectors
  const catalogContent = useCatalogEditorStore((s) => s.content.toml);
  const setToml = useCatalogEditorStore((s) => s.setToml);

  const caseValue = useCatalogEditorStore((s) => s.forms.muxCaseValue);
  const caseNotes = useCatalogEditorStore((s) => s.forms.muxCaseNotes);
  const setCaseValue = useCatalogEditorStore((s) => s.setMuxCaseValue);
  const setCaseNotes = useCatalogEditorStore((s) => s.setMuxCaseNotes);

  const dialogPayload = useCatalogEditorStore((s) => s.ui.dialogPayload);
  const openDialog = useCatalogEditorStore((s) => s.openDialog);
  const closeDialog = useCatalogEditorStore((s) => s.closeDialog);
  const setDialogPayload = useCatalogEditorStore((s) => s.setDialogPayload);

  const setValidation = useCatalogEditorStore((s) => s.setValidation);
  const clearValidation = useCatalogEditorStore((s) => s.clearValidation);
  const setSelectedPath = useCatalogEditorStore((s) => s.setSelectedPath);
  const selectedPath = useCatalogEditorStore((s) => s.tree.selectedPath);

  /** `ownerPath` is the frame or the mux case the new selector belongs to. */
  const handleAddMux = (ownerPath: string[]) => {
    setCurrentMuxPath(ownerPath);
    setIsAddingNestedMux(ownerPath.length > 3);
    setIsEditingExistingMux(false);
    setMuxFields(NEW_MUX_FIELDS);
    setEditingMux(true);
  };

  const handleEditMux = (muxPath: string[], mux: Mux) => {
    setCurrentMuxPath(muxPath);
    setIsAddingNestedMux(false);
    setIsEditingExistingMux(true);
    setMuxFields({
      name: mux.name ?? "",
      start_bit: mux.startBit,
      bit_length: mux.bitLength,
      notes: mux.notes?.join("\n"),
    });
    setEditingMux(true);
  };

  const handleSaveMux = async () => {
    const ownerPath = isEditingExistingMux ? currentMuxPath.slice(0, -1) : currentMuxPath;
    try {
      setToml(await upsertMuxToml(catalogContent, ownerPath, muxFields));
      setEditingMux(false);
    } catch (error) {
      showRefusal("mux", error);
    }
  };

  const handleDeleteMux = async (muxPath: string[]) => {
    try {
      const newContent = await deleteMuxToml(catalogContent, muxPath);
      setToml(newContent);
      setSelectedPath(null);
    } catch (error) {
      console.error("Failed to delete mux:", error);
    }
  };

  // Mux case operations
  const handleAddCase = (muxPath: string[]) => {
    setDialogPayload({ currentMuxPath: muxPath });
    setCaseValue("");
    setCaseNotes("");
    openDialog("addMuxCase");
  };

  const handleSaveCase = async () => {
    if (!caseValue.trim()) return;

    try {
      const notesToSave = caseNotes.trim() || undefined;
      const { toml: newContent, didAdd } = await addMuxCaseToml(
        catalogContent,
        dialogPayload.currentMuxPath,
        caseValue,
        notesToSave
      );
      if (!didAdd) {
        setValidation([{ field: "case", message: `Case ${caseValue} already exists` }]);
        return;
      }

      setToml(newContent);
      closeDialog("addMuxCase");
      setCaseValue("");
      setCaseNotes("");
      clearValidation();
    } catch (error) {
      console.error("Failed to add case:", error);
      setValidation([{ field: "case", message: "Failed to add case" }]);
    }
  };

  const handleEditCase = (muxPath: string[], currentCaseValue: string, currentCaseNotes?: string) => {
    setDialogPayload({
      editingCaseMuxPath: muxPath,
      editingCaseOriginalValue: currentCaseValue,
    });
    setCaseValue(currentCaseValue);
    setCaseNotes(currentCaseNotes || "");
    openDialog("editMuxCase");
  };

  const handleSaveEditCase = async () => {
    if (!caseValue.trim()) return;

    const muxPath = dialogPayload.editingCaseMuxPath;
    const originalValue = dialogPayload.editingCaseOriginalValue;
    if (!muxPath || !originalValue) return;

    try {
      const notesToSave = caseNotes.trim() || undefined;
      const { toml: newContent, success, error } = await editMuxCaseToml(
        catalogContent,
        muxPath,
        originalValue,
        caseValue,
        notesToSave
      );

      if (!success) {
        setValidation([{ field: "case", message: error || "Failed to edit case" }]);
        return;
      }

      setToml(newContent);
      closeDialog("editMuxCase");
      setCaseValue("");
      setCaseNotes("");
      setDialogPayload({ editingCaseMuxPath: null, editingCaseOriginalValue: null });
      clearValidation();

      if (originalValue !== caseValue && selectedPath) {
        const newPath = [...selectedPath.slice(0, -1), caseValue];
        setSelectedPath(newPath);
      }
    } catch (error) {
      console.error("Failed to edit case:", error);
      setValidation([{ field: "case", message: "Failed to edit case" }]);
    }
  };

  const handleDeleteCase = async (muxPath: string[], caseKey: string) => {
    try {
      const newContent = await deleteMuxCaseToml(catalogContent, muxPath, caseKey);
      setToml(newContent);
      setSelectedPath(null);
    } catch (error) {
      console.error("Failed to delete case:", error);
    }
  };

  return {
    handleAddMux,
    handleEditMux,
    handleSaveMux,
    handleDeleteMux,

    // Mux case operations
    handleAddCase,
    handleSaveCase,
    handleEditCase,
    handleSaveEditCase,
    handleDeleteCase,
  };
}
