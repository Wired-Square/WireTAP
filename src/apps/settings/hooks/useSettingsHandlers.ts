// ui/src/apps/settings/hooks/useSettingsHandlers.ts
// Orchestrator hook that composes all domain handlers

import { useIOProfileHandlers, type IOProfileHandlers } from './handlers/useIOProfileHandlers';
import {
  useSettingsCatalogHandlers,
  type SettingsCatalogHandlers,
} from './handlers/useSettingsCatalogHandlers';
import {
  useBookmarkHandlers,
  type BookmarkHandlers,
} from './handlers/useBookmarkHandlers';
import {
  useSelectionSetSettingsHandlers,
  type SelectionSetSettingsHandlers,
} from './handlers/useSelectionSetSettingsHandlers';
import {
  useGraphLayoutHandlers,
  type GraphLayoutHandlers,
} from './handlers/useGraphLayoutHandlers';
import type { IOProfile } from '../stores/settingsStore';
import type { TimeBounds } from '../../../components/TimeBoundsInput';

export interface UseSettingsHandlersParams {
  // Form state from useSettingsForms
  catalogName: string;
  catalogFilename: string;
  setCatalogName: (name: string) => void;
  setCatalogFilename: (filename: string) => void;
  resetCatalogForm: () => void;
  initDuplicateCatalogForm: (name: string, filename: string) => void;
  initEditCatalogForm: (name: string, filename: string) => void;

  // Bookmark form (editing)
  bookmarkName: string;
  bookmarkTimeBounds: TimeBounds;
  resetBookmarkForm: () => void;
  initEditBookmarkForm: (
    name: string,
    startTime: string,
    endTime: string,
    maxFrames?: number
  ) => void;

  // New bookmark form (creating)
  newBookmarkProfileId: string;
  newBookmarkName: string;
  newBookmarkTimeBounds: TimeBounds;
  resetNewBookmarkForm: () => void;
  initNewBookmarkForm: (defaultProfileId: string) => void;
  timeRangeCapableProfiles: IOProfile[];

  // Selection set form (editing)
  selectionSetName: string;
  resetSelectionSetForm: () => void;
  initEditSelectionSetForm: (name: string) => void;

  // Graph layout form (editing)
  graphLayoutName: string;
  resetGraphLayoutForm: () => void;
  initEditGraphLayoutForm: (name: string) => void;
}

export type SettingsHandlers = IOProfileHandlers & SettingsCatalogHandlers & BookmarkHandlers & SelectionSetSettingsHandlers & GraphLayoutHandlers;

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

  // Bookmark handlers
  const bookmarkHandlers = useBookmarkHandlers({
    bookmarkName: params.bookmarkName,
    bookmarkTimeBounds: params.bookmarkTimeBounds,
    resetBookmarkForm: params.resetBookmarkForm,
    initEditBookmarkForm: params.initEditBookmarkForm,
    newBookmarkProfileId: params.newBookmarkProfileId,
    newBookmarkName: params.newBookmarkName,
    newBookmarkTimeBounds: params.newBookmarkTimeBounds,
    resetNewBookmarkForm: params.resetNewBookmarkForm,
    initNewBookmarkForm: params.initNewBookmarkForm,
    timeRangeCapableProfiles: params.timeRangeCapableProfiles,
  });

  // Selection set handlers
  const selectionSetHandlers = useSelectionSetSettingsHandlers({
    selectionSetName: params.selectionSetName,
    resetSelectionSetForm: params.resetSelectionSetForm,
    initEditSelectionSetForm: params.initEditSelectionSetForm,
  });

  // Graph layout handlers
  const graphLayoutHandlers = useGraphLayoutHandlers({
    graphLayoutName: params.graphLayoutName,
    resetGraphLayoutForm: params.resetGraphLayoutForm,
    initEditGraphLayoutForm: params.initEditGraphLayoutForm,
  });

  // Spread all handlers into a flat object
  return {
    ...ioProfileHandlers,
    ...catalogHandlers,
    ...bookmarkHandlers,
    ...selectionSetHandlers,
    ...graphLayoutHandlers,
  };
}
