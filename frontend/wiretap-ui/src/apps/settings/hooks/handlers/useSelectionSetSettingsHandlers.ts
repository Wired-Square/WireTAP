// ui/src/apps/settings/hooks/handlers/useSelectionSetSettingsHandlers.ts

import {
  updateSelectionSet,
  deleteSelectionSet,
  type SelectionSet,
} from '../../../../utils/selectionSets';
import { useSettingsStore } from '../../stores/settingsStore';

export interface UseSelectionSetSettingsHandlersParams {
  selectionSetName: string;
  resetSelectionSetForm: () => void;
  initEditSelectionSetForm: (name: string) => void;
}

export function useSelectionSetSettingsHandlers({
  selectionSetName,
  resetSelectionSetForm,
  initEditSelectionSetForm,
}: UseSelectionSetSettingsHandlersParams) {
  const dialogPayload = useSettingsStore((s) => s.ui.dialogPayload);
  const loadSelectionSets = useSettingsStore((s) => s.loadSelectionSets);
  const openDialog = useSettingsStore((s) => s.openDialog);
  const closeDialog = useSettingsStore((s) => s.closeDialog);
  const setDialogPayload = useSettingsStore((s) => s.setDialogPayload);

  // Open edit dialog
  const handleEditSelectionSet = (set: SelectionSet) => {
    setDialogPayload({ selectionSetToEdit: set });
    initEditSelectionSetForm(set.name);
    openDialog('editSelectionSet');
  };

  // Confirm edit
  const handleConfirmEditSelectionSet = async () => {
    const set = dialogPayload.selectionSetToEdit;
    if (!set) return;

    try {
      await updateSelectionSet(set.id, { name: selectionSetName });
      await loadSelectionSets();
      closeDialog('editSelectionSet');
      setDialogPayload({ selectionSetToEdit: null });
      resetSelectionSetForm();
    } catch (error) {
      console.error('Failed to update selection set:', error);
    }
  };

  // Cancel edit
  const handleCancelEditSelectionSet = () => {
    closeDialog('editSelectionSet');
    setDialogPayload({ selectionSetToEdit: null });
    resetSelectionSetForm();
  };

  // Open delete confirmation dialog
  const handleDeleteSelectionSet = (set: SelectionSet) => {
    setDialogPayload({ selectionSetToDelete: set });
    openDialog('deleteSelectionSet');
  };

  // Confirm deletion
  const handleConfirmDeleteSelectionSet = async () => {
    const set = dialogPayload.selectionSetToDelete;
    if (!set) return;

    try {
      await deleteSelectionSet(set.id);
      await loadSelectionSets();
      closeDialog('deleteSelectionSet');
      setDialogPayload({ selectionSetToDelete: null });
    } catch (error) {
      console.error('Failed to delete selection set:', error);
    }
  };

  // Cancel deletion
  const handleCancelDeleteSelectionSet = () => {
    closeDialog('deleteSelectionSet');
    setDialogPayload({ selectionSetToDelete: null });
  };

  return {
    handleEditSelectionSet,
    handleConfirmEditSelectionSet,
    handleCancelEditSelectionSet,
    handleDeleteSelectionSet,
    handleConfirmDeleteSelectionSet,
    handleCancelDeleteSelectionSet,
  };
}

export type SelectionSetSettingsHandlers = ReturnType<typeof useSelectionSetSettingsHandlers>;
