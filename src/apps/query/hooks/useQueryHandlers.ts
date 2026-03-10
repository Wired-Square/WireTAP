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
import type { LoadOptions } from "../../../hooks/useIOSessionManager";
import type { TimeRangeFavorite } from "../../../utils/favorites";

export interface UseQueryHandlersParams {
  // Session manager actions
  watchSource: (
    profileIds: string[],
    options: LoadOptions
  ) => Promise<void>;
  stopWatch: () => Promise<void>;

  // Profile state
  sourceProfileId: string | null;

  // Dialog controls
  openIoSessionPicker: () => void;
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
  // Session handlers (ingest, stop)
  const sessionHandlers = useQuerySessionHandlers({
    watchSource: params.watchSource,
    stopWatch: params.stopWatch,
    sourceProfileId: params.sourceProfileId,
  });

  // UI handlers (dialogs, tabs, queue, bookmarks)
  const uiHandlers = useQueryUIHandlers({
    openCatalogPicker: params.openCatalogPicker,
    closeCatalogPicker: params.closeCatalogPicker,
    openErrorDialog: params.openErrorDialog,
    closeErrorDialog: params.closeErrorDialog,
    openAddBookmarkDialog: params.openAddBookmarkDialog,
    closeAddBookmarkDialog: params.closeAddBookmarkDialog,
    ioProfile: params.sourceProfileId,
    setActiveTab: params.setActiveTab,
    setFavourites: params.setFavourites,
  });

  // Spread all handlers into a flat object
  return {
    ...sessionHandlers,
    ...uiHandlers,
  };
}
