// ui/src/apps/settings/hooks/useSettingsHandlers.ts
// Orchestrator hook that composes all domain handlers

import { useIOProfileHandlers, type IOProfileHandlers } from './handlers/useIOProfileHandlers';
import {
  useSettingsCatalogHandlers,
  type SettingsCatalogHandlers,
} from './handlers/useSettingsCatalogHandlers';
import {
  useSelectionSetSettingsHandlers,
  type SelectionSetSettingsHandlers,
} from './handlers/useSelectionSetSettingsHandlers';
import {
  useDashboardLayoutHandlers,
  type DashboardLayoutHandlers,
} from './handlers/useDashboardLayoutHandlers';

export interface UseSettingsHandlersParams {
  // Form state from useSettingsForms
  catalogName: string;
  catalogFilename: string;
  setCatalogName: (name: string) => void;
  setCatalogFilename: (filename: string) => void;
  resetCatalogForm: () => void;
  initDuplicateCatalogForm: (name: string, filename: string) => void;
  initEditCatalogForm: (name: string, filename: string) => void;

  // Selection set form (editing)
  selectionSetName: string;
  resetSelectionSetForm: () => void;
  initEditSelectionSetForm: (name: string) => void;

  // Dashboard layout form (editing)
  dashboardLayoutName: string;
  resetDashboardLayoutForm: () => void;
  initEditDashboardLayoutForm: (name: string) => void;
}

export type SettingsHandlers = IOProfileHandlers & SettingsCatalogHandlers & SelectionSetSettingsHandlers & DashboardLayoutHandlers;

export function useSettingsHandlers(params: UseSettingsHandlersParams): SettingsHandlers {
  // IO Profile handlers (no params needed - uses store directly)
  const ioProfileHandlers = useIOProfileHandlers();

  // Catalog handlers
  const catalogHandlers = useSettingsCatalogHandlers({
    catalogName: params.catalogName,
    catalogFilename: params.catalogFilename,
    setCatalogName: params.setCatalogName,
    setCatalogFilename: params.setCatalogFilename,
    resetCatalogForm: params.resetCatalogForm,
    initDuplicateCatalogForm: params.initDuplicateCatalogForm,
    initEditCatalogForm: params.initEditCatalogForm,
  });

  // Selection set handlers
  const selectionSetHandlers = useSelectionSetSettingsHandlers({
    selectionSetName: params.selectionSetName,
    resetSelectionSetForm: params.resetSelectionSetForm,
    initEditSelectionSetForm: params.initEditSelectionSetForm,
  });

  // Dashboard layout handlers
  const dashboardLayoutHandlers = useDashboardLayoutHandlers({
    dashboardLayoutName: params.dashboardLayoutName,
    resetDashboardLayoutForm: params.resetDashboardLayoutForm,
    initEditDashboardLayoutForm: params.initEditDashboardLayoutForm,
  });

  // Spread all handlers into a flat object
  return {
    ...ioProfileHandlers,
    ...catalogHandlers,
    ...selectionSetHandlers,
    ...dashboardLayoutHandlers,
  };
}
