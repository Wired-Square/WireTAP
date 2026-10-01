// ui/src/apps/settings/hooks/handlers/useSettingsCatalogHandlers.ts
// Note: Named differently from catalog editor's useCatalogHandlers to avoid confusion.
// This handles catalog list management (duplicate, rename, delete), not editing.

import { useState } from 'react';
import {
  duplicateCatalog as duplicateCatalogApi,
  renameCatalog as renameCatalogApi,
  deleteCatalog as deleteCatalogApi,
} from '../../../../api';
import { useSettingsStore, type CatalogFile } from '../../stores/settingsStore';

export interface UseSettingsCatalogHandlersParams {
  // Form state from useSettingsForms
  catalogName: string;
  catalogFilename: string;
  setCatalogName: (name: string) => void;
  setCatalogFilename: (filename: string) => void;
  resetCatalogForm: () => void;
  initDuplicateCatalogForm: (name: string, filename: string) => void;
  initEditCatalogForm: (name: string, filename: string) => void;
}

export function useSettingsCatalogHandlers({
  catalogName,
  catalogFilename,
  resetCatalogForm,
  initDuplicateCatalogForm,
  initEditCatalogForm,
}: UseSettingsCatalogHandlersParams) {
  // Store selectors
  const dialogPayload = useSettingsStore((s) => s.ui.dialogPayload);

  // Store actions
  const openDialog = useSettingsStore((s) => s.openDialog);
  const closeDialog = useSettingsStore((s) => s.closeDialog);
  const setDialogPayload = useSettingsStore((s) => s.setDialogPayload);
  const [catalogError, setCatalogError] = useState<string | null>(null);

  // Open duplicate dialog
  const handleDuplicateCatalog = (catalog: CatalogFile) => {
    setDialogPayload({ catalogToDuplicate: catalog });
    setCatalogError(null);
    initDuplicateCatalogForm(catalog.name, catalog.filename);
    openDialog('duplicateCatalog');
  };

  // Confirm duplication
  const handleConfirmDuplicate = async () => {
    const catalog = dialogPayload.catalogToDuplicate;
    if (!catalog || !catalogFilename) return;

    try {
      await duplicateCatalogApi(catalog.path, catalogName, catalogFilename);
      closeDialog('duplicateCatalog');
      setDialogPayload({ catalogToDuplicate: null });
      resetCatalogForm();
    } catch (error) {
      setCatalogError(String(error));
    }
  };

  // Cancel duplication
  const handleCancelDuplicate = () => {
    closeDialog('duplicateCatalog');
    setDialogPayload({ catalogToDuplicate: null });
    resetCatalogForm();
  };

  // Open edit dialog
  const handleEditCatalog = (catalog: CatalogFile) => {
    setDialogPayload({ catalogToEdit: catalog });
    setCatalogError(null);
    initEditCatalogForm(catalog.name, catalog.filename);
    openDialog('editCatalog');
  };

  // Confirm edit (rename)
  const handleConfirmEdit = async () => {
    const catalog = dialogPayload.catalogToEdit;
    if (!catalog || !catalogFilename) return;

    try {
      await renameCatalogApi(catalog.path, catalogName, catalogFilename);

      closeDialog('editCatalog');
      setDialogPayload({ catalogToEdit: null });
      resetCatalogForm();
    } catch (error) {
      setCatalogError(String(error));
    }
  };

  // Cancel edit
  const handleCancelEdit = () => {
    closeDialog('editCatalog');
    setDialogPayload({ catalogToEdit: null });
    resetCatalogForm();
  };

  // Open delete confirmation dialog
  const handleDeleteCatalog = (catalog: CatalogFile) => {
    setDialogPayload({ catalogToDelete: catalog });
    openDialog('deleteCatalog');
  };

  // Confirm deletion
  const handleConfirmDelete = async () => {
    const catalog = dialogPayload.catalogToDelete;
    if (!catalog) return;

    try {
      await deleteCatalogApi(catalog.path);

      closeDialog('deleteCatalog');
      setDialogPayload({ catalogToDelete: null });
    } catch (error) {
      console.error('Failed to delete catalog:', error);
    }
  };

  // Cancel deletion
  const handleCancelDelete = () => {
    closeDialog('deleteCatalog');
    setDialogPayload({ catalogToDelete: null });
  };

  return {
    catalogError,
    handleDuplicateCatalog,
    handleConfirmDuplicate,
    handleCancelDuplicate,
    handleEditCatalog,
    handleConfirmEdit,
    handleCancelEdit,
    handleDeleteCatalog,
    handleConfirmDelete,
    handleCancelDelete,
  };
}

export type SettingsCatalogHandlers = ReturnType<typeof useSettingsCatalogHandlers>;
