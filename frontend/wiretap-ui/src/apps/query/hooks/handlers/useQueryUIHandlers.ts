// src/apps/query/hooks/handlers/useQueryUIHandlers.ts
//
// UI-related handlers for Query: dialogs, tabs, queue, export.

import { useCallback } from "react";
import { useQueryStore } from "../../stores/queryStore";
import { exportQueryCsv } from "../../../../api/query";
import type { TimeBounds } from "../../../../components/TimeBoundsInput";
import { pickFileToSave, CSV_FILTERS } from "../../../../api/dialogs";
import { saveCatalog } from "../../../../api/catalog";

export interface UseQueryUIHandlersParams {
  // Dialog controls
  openCatalogPicker: () => void;
  closeCatalogPicker: () => void;
  openErrorDialog: () => void;
  closeErrorDialog: () => void;

  // Tab state
  setActiveTab: (tab: string) => void;
}

export function useQueryUIHandlers({
  closeErrorDialog,
  setActiveTab,
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

  const handleExportQuery = useCallback(async (queryId: string | undefined) => {
    const query = useQueryStore.getState().queue.find((q) => q.id === queryId);
    if (query?.status !== "completed") return;

    const csv = await exportQueryCsv(query.id);
    const safeName = query.label.replace(/[^a-zA-Z0-9_\-. ]/g, "_");
    const path = await pickFileToSave({
      defaultPath: `${safeName}.csv`,
      filters: CSV_FILTERS,
    });

    if (path) {
      await saveCatalog(path, csv);
    }
  }, []);

  return {
    handleCloseError,
    handleCatalogChange,
    handleTimeBoundsChange,
    handleSelectQuery,
    handleRemoveQuery,
    handleExportQuery,
  };
}

export type QueryUIHandlers = ReturnType<typeof useQueryUIHandlers>;
