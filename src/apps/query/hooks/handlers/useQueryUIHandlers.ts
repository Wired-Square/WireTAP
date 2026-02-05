// src/apps/query/hooks/handlers/useQueryUIHandlers.ts
//
// UI-related handlers for Query: dialogs, tabs, queue, bookmarks, export.

import { useCallback } from "react";
import { useQueryStore } from "../../stores/queryStore";
import { addFavorite, getFavoritesForProfile, type TimeRangeFavorite } from "../../../../utils/favorites";
import type { TimeBounds } from "../../../../components/TimeBoundsInput";

export interface UseQueryUIHandlersParams {
  // Dialog controls
  openIoReaderPicker: () => void;
  closeIoReaderPicker: () => void;
  openCatalogPicker: () => void;
  closeCatalogPicker: () => void;
  openErrorDialog: () => void;
  closeErrorDialog: () => void;
  openAddBookmarkDialog: () => void;
  closeAddBookmarkDialog: () => void;

  // Profile state (for bookmarks)
  ioProfile: string | null;

  // Tab state
  setActiveTab: (tab: string) => void;

  // Favourites state
  setFavourites: (favs: TimeRangeFavorite[]) => void;
}

export function useQueryUIHandlers({
  closeErrorDialog,
  openAddBookmarkDialog,
  closeAddBookmarkDialog,
  ioProfile,
  setActiveTab,
  setFavourites,
}: UseQueryUIHandlersParams) {
  // Store actions
  const setError = useQueryStore((s) => s.setError);
  const setCatalogPath = useQueryStore((s) => s.setCatalogPath);
  const setSelectedQueryId = useQueryStore((s) => s.setSelectedQueryId);
  const removeQueueItem = useQueryStore((s) => s.removeQueueItem);

  // Close error dialog
  const handleCloseError = useCallback(() => {
    setError(null);
    closeErrorDialog();
  }, [setError, closeErrorDialog]);

  // Handle catalog selection
  const handleCatalogChange = useCallback(
    (path: string) => {
      setCatalogPath(path);
    },
    [setCatalogPath]
  );

  // Handle time bounds change
  const handleTimeBoundsChange = useCallback(
    (bounds: TimeBounds, setTimeBounds: (bounds: TimeBounds) => void) => {
      setTimeBounds(bounds);
    },
    []
  );

  // Handle queue item selection
  const handleSelectQuery = useCallback(
    (id: string) => {
      setSelectedQueryId(id);
      setActiveTab("results");
    },
    [setSelectedQueryId, setActiveTab]
  );

  // Handle queue item removal
  const handleRemoveQuery = useCallback(
    (id: string) => {
      removeQueueItem(id);
    },
    [removeQueueItem]
  );

  // Handle bookmark button click (from results)
  const handleBookmarkQuery = useCallback(
    (hasSelectedQuery: boolean) => {
      if (hasSelectedQuery) {
        openAddBookmarkDialog();
      }
    },
    [openAddBookmarkDialog]
  );

  // Handle save bookmark
  const handleSaveBookmark = useCallback(
    async (name: string, startTime: string, endTime: string) => {
      if (!ioProfile) return;
      try {
        await addFavorite(name, ioProfile, startTime, endTime);
        // Reload favourites
        const favs = await getFavoritesForProfile(ioProfile);
        setFavourites(favs);
        closeAddBookmarkDialog();
      } catch (e) {
        console.error("Failed to save bookmark:", e);
      }
    },
    [ioProfile, setFavourites, closeAddBookmarkDialog]
  );

  // Handle export (placeholder)
  const handleExportQuery = useCallback((queryId: string | undefined) => {
    // TODO: Implement export functionality
    console.log("Export query results:", queryId);
  }, []);

  return {
    handleCloseError,
    handleCatalogChange,
    handleTimeBoundsChange,
    handleSelectQuery,
    handleRemoveQuery,
    handleBookmarkQuery,
    handleSaveBookmark,
    handleExportQuery,
  };
}

export type QueryUIHandlers = ReturnType<typeof useQueryUIHandlers>;
