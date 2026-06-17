// ui/src/apps/settings/hooks/handlers/useDashboardLayoutHandlers.ts

import {
  updateDashboardLayout,
  deleteDashboardLayout,
  type DashboardLayout,
} from '../../../../utils/dashboardLayouts';
import { useSettingsStore } from '../../stores/settingsStore';

export interface UseDashboardLayoutHandlersParams {
  dashboardLayoutName: string;
  resetDashboardLayoutForm: () => void;
  initEditDashboardLayoutForm: (name: string) => void;
}

export function useDashboardLayoutHandlers({
  dashboardLayoutName,
  resetDashboardLayoutForm,
  initEditDashboardLayoutForm,
}: UseDashboardLayoutHandlersParams) {
  const dialogPayload = useSettingsStore((s) => s.ui.dialogPayload);
  const loadDashboardLayouts = useSettingsStore((s) => s.loadDashboardLayouts);
  const openDialog = useSettingsStore((s) => s.openDialog);
  const closeDialog = useSettingsStore((s) => s.closeDialog);
  const setDialogPayload = useSettingsStore((s) => s.setDialogPayload);

  // Open edit dialog
  const handleEditDashboardLayout = (layout: DashboardLayout) => {
    setDialogPayload({ dashboardLayoutToEdit: layout });
    initEditDashboardLayoutForm(layout.name);
    openDialog('editDashboardLayout');
  };

  // Confirm edit
  const handleConfirmEditDashboardLayout = async () => {
    const layout = dialogPayload.dashboardLayoutToEdit;
    if (!layout) return;

    try {
      await updateDashboardLayout(layout.id, { name: dashboardLayoutName });
      await loadDashboardLayouts();
      closeDialog('editDashboardLayout');
      setDialogPayload({ dashboardLayoutToEdit: null });
      resetDashboardLayoutForm();
    } catch (error) {
      console.error('Failed to update graph layout:', error);
    }
  };

  // Cancel edit
  const handleCancelEditDashboardLayout = () => {
    closeDialog('editDashboardLayout');
    setDialogPayload({ dashboardLayoutToEdit: null });
    resetDashboardLayoutForm();
  };

  // Open delete confirmation dialog
  const handleDeleteDashboardLayout = (layout: DashboardLayout) => {
    setDialogPayload({ dashboardLayoutToDelete: layout });
    openDialog('deleteDashboardLayout');
  };

  // Confirm deletion
  const handleConfirmDeleteDashboardLayout = async () => {
    const layout = dialogPayload.dashboardLayoutToDelete;
    if (!layout) return;

    try {
      await deleteDashboardLayout(layout.id);
      await loadDashboardLayouts();
      closeDialog('deleteDashboardLayout');
      setDialogPayload({ dashboardLayoutToDelete: null });
    } catch (error) {
      console.error('Failed to delete graph layout:', error);
    }
  };

  // Cancel deletion
  const handleCancelDeleteDashboardLayout = () => {
    closeDialog('deleteDashboardLayout');
    setDialogPayload({ dashboardLayoutToDelete: null });
  };

  return {
    handleEditDashboardLayout,
    handleConfirmEditDashboardLayout,
    handleCancelEditDashboardLayout,
    handleDeleteDashboardLayout,
    handleConfirmDeleteDashboardLayout,
    handleCancelDeleteDashboardLayout,
  };
}

export type DashboardLayoutHandlers = ReturnType<typeof useDashboardLayoutHandlers>;
