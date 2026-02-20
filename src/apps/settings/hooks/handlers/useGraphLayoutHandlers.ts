// ui/src/apps/settings/hooks/handlers/useGraphLayoutHandlers.ts

import {
  updateGraphLayout,
  deleteGraphLayout,
  type GraphLayout,
} from '../../../../utils/graphLayouts';
import { useSettingsStore } from '../../stores/settingsStore';

export interface UseGraphLayoutHandlersParams {
  graphLayoutName: string;
  resetGraphLayoutForm: () => void;
  initEditGraphLayoutForm: (name: string) => void;
}

export function useGraphLayoutHandlers({
  graphLayoutName,
  resetGraphLayoutForm,
  initEditGraphLayoutForm,
}: UseGraphLayoutHandlersParams) {
  const dialogPayload = useSettingsStore((s) => s.ui.dialogPayload);
  const loadGraphLayouts = useSettingsStore((s) => s.loadGraphLayouts);
  const openDialog = useSettingsStore((s) => s.openDialog);
  const closeDialog = useSettingsStore((s) => s.closeDialog);
  const setDialogPayload = useSettingsStore((s) => s.setDialogPayload);

  // Open edit dialog
  const handleEditGraphLayout = (layout: GraphLayout) => {
    setDialogPayload({ graphLayoutToEdit: layout });
    initEditGraphLayoutForm(layout.name);
    openDialog('editGraphLayout');
  };

  // Confirm edit
  const handleConfirmEditGraphLayout = async () => {
    const layout = dialogPayload.graphLayoutToEdit;
    if (!layout) return;

    try {
      await updateGraphLayout(layout.id, { name: graphLayoutName });
      await loadGraphLayouts();
      closeDialog('editGraphLayout');
      setDialogPayload({ graphLayoutToEdit: null });
      resetGraphLayoutForm();
    } catch (error) {
      console.error('Failed to update graph layout:', error);
    }
  };

  // Cancel edit
  const handleCancelEditGraphLayout = () => {
    closeDialog('editGraphLayout');
    setDialogPayload({ graphLayoutToEdit: null });
    resetGraphLayoutForm();
  };

  // Open delete confirmation dialog
  const handleDeleteGraphLayout = (layout: GraphLayout) => {
    setDialogPayload({ graphLayoutToDelete: layout });
    openDialog('deleteGraphLayout');
  };

  // Confirm deletion
  const handleConfirmDeleteGraphLayout = async () => {
    const layout = dialogPayload.graphLayoutToDelete;
    if (!layout) return;

    try {
      await deleteGraphLayout(layout.id);
      await loadGraphLayouts();
      closeDialog('deleteGraphLayout');
      setDialogPayload({ graphLayoutToDelete: null });
    } catch (error) {
      console.error('Failed to delete graph layout:', error);
    }
  };

  // Cancel deletion
  const handleCancelDeleteGraphLayout = () => {
    closeDialog('deleteGraphLayout');
    setDialogPayload({ graphLayoutToDelete: null });
  };

  return {
    handleEditGraphLayout,
    handleConfirmEditGraphLayout,
    handleCancelEditGraphLayout,
    handleDeleteGraphLayout,
    handleConfirmDeleteGraphLayout,
    handleCancelDeleteGraphLayout,
  };
}

export type GraphLayoutHandlers = ReturnType<typeof useGraphLayoutHandlers>;
