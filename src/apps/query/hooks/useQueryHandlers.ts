// src/apps/query/hooks/useQueryHandlers.ts
//
// Orchestrator hook that composes all Query domain handlers.

import {
  useQuerySessionHandlers,
  type QuerySessionHandlers,
} from "./handlers/useQuerySessionHandlers";
import {
  useQueryUIHandlers,
  type QueryUIHandlers,
} from "./handlers/useQueryUIHandlers";
import type { IngestOptions } from "../../../hooks/useIOSessionManager";
import type { TimeRangeFavorite } from "../../../utils/favorites";

export interface UseQueryHandlersParams {
  // Session manager actions
  connectOnly: (profileId: string, options?: IngestOptions) => Promise<void>;
  watchSingleSource: (
    profileId: string,
    options: IngestOptions
  ) => Promise<void>;
  stopWatch: () => Promise<void>;
  skipReader: () => Promise<void>;

  // Profile state
  ioProfile: string | null;
  setIoProfile: (profileId: string | null) => void;

  // Dialog controls
  openIoReaderPicker: () => void;
  closeIoReaderPicker: () => void;
  openCatalogPicker: () => void;
  closeCatalogPicker: () => void;
  openErrorDialog: () => void;
  closeErrorDialog: () => void;
  openAddBookmarkDialog: () => void;
  closeAddBookmarkDialog: () => void;

  // Tab state
  setActiveTab: (tab: string) => void;

  // Favourites state
  setFavourites: (favs: TimeRangeFavorite[]) => void;
}

export type QueryHandlers = QuerySessionHandlers & QueryUIHandlers;

export function useQueryHandlers(params: UseQueryHandlersParams): QueryHandlers {
  // Session handlers (connect, ingest, stop, skip)
  const sessionHandlers = useQuerySessionHandlers({
    connectOnly: params.connectOnly,
    watchSingleSource: params.watchSingleSource,
    stopWatch: params.stopWatch,
    skipReader: params.skipReader,
    ioProfile: params.ioProfile,
    setIoProfile: params.setIoProfile,
    closeIoReaderPicker: params.closeIoReaderPicker,
  });

  // UI handlers (dialogs, tabs, queue, bookmarks)
  const uiHandlers = useQueryUIHandlers({
    openIoReaderPicker: params.openIoReaderPicker,
    closeIoReaderPicker: params.closeIoReaderPicker,
    openCatalogPicker: params.openCatalogPicker,
    closeCatalogPicker: params.closeCatalogPicker,
    openErrorDialog: params.openErrorDialog,
    closeErrorDialog: params.closeErrorDialog,
    openAddBookmarkDialog: params.openAddBookmarkDialog,
    closeAddBookmarkDialog: params.closeAddBookmarkDialog,
    ioProfile: params.ioProfile,
    setActiveTab: params.setActiveTab,
    setFavourites: params.setFavourites,
  });

  // Spread all handlers into a flat object
  return {
    ...sessionHandlers,
    ...uiHandlers,
  };
}
