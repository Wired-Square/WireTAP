// ui/src/apps/settings/hooks/useSettingsForms.ts

import { useState, useCallback } from 'react';

export interface CatalogFormState {
  name: string;
  filename: string;
}

export function useSettingsForms() {
  // Catalog dialog form (used for both duplicate and edit)
  const [catalogName, setCatalogName] = useState('');
  const [catalogFilename, setCatalogFilename] = useState('');

  // Selection set dialog form (for editing)
  const [selectionSetName, setSelectionSetName] = useState('');

  // Dashboard layout dialog form (for editing)
  const [dashboardLayoutName, setDashboardLayoutName] = useState('');

  // Reset helpers
  const resetCatalogForm = () => {
    setCatalogName('');
    setCatalogFilename('');
  };

  // Initialize catalog form for duplication
  const initDuplicateCatalogForm = (name: string, filename: string) => {
    setCatalogName(name + ' (Copy)');
    setCatalogFilename(filename.replace('.toml', '-copy.toml'));
  };

  // Initialize catalog form for editing
  const initEditCatalogForm = (name: string, filename: string) => {
    setCatalogName(name);
    setCatalogFilename(filename);
  };

  // Reset / initialize selection set form
  const resetSelectionSetForm = useCallback(() => {
    setSelectionSetName('');
  }, []);

  const initEditSelectionSetForm = useCallback((name: string) => {
    setSelectionSetName(name);
  }, []);

  // Reset / initialize graph layout form
  const resetDashboardLayoutForm = useCallback(() => {
    setDashboardLayoutName('');
  }, []);

  const initEditDashboardLayoutForm = useCallback((name: string) => {
    setDashboardLayoutName(name);
  }, []);

  return {
    // Catalog form
    catalogName,
    setCatalogName,
    catalogFilename,
    setCatalogFilename,
    resetCatalogForm,
    initDuplicateCatalogForm,
    initEditCatalogForm,

    // Selection set form (editing)
    selectionSetName,
    setSelectionSetName,
    resetSelectionSetForm,
    initEditSelectionSetForm,

    // Dashboard layout form (editing)
    dashboardLayoutName,
    setDashboardLayoutName,
    resetDashboardLayoutForm,
    initEditDashboardLayoutForm,
  };
}

export type SettingsFormsState = ReturnType<typeof useSettingsForms>;
