// src/apps/query/hooks/handlers/useQueryUIHandlers.ts
//
// UI-related handlers for Query: dialogs, tabs, queue, bookmarks, export.

import { useCallback } from "react";
import { useQueryStore, type QueuedQuery, type ByteChangeResult, type FrameChangeResult, type MirrorValidationResult } from "../../stores/queryStore";
import type {
  MuxStatisticsResult,
  FirstLastResult,
  FrequencyBucket,
  DistributionResult,
  GapResult,
  PatternSearchResult,
} from "../../../../api/dbquery";
import { addFavorite, getFavoritesForProfile, type TimeRangeFavorite } from "../../../../utils/favorites";
import type { TimeBounds } from "../../../../components/TimeBoundsInput";
import { pickFileToSave, CSV_FILTERS } from "../../../../api/dialogs";
import { saveCatalog } from "../../../../api/catalog";
import { buildCsv, formatPayloadHex } from "../../../../utils/csvBuilder";

export interface UseQueryUIHandlersParams {
  // Dialog controls
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

  // Handle export — build CSV from query results and save via file dialog
  const handleExportQuery = useCallback(async (queryId: string | undefined) => {
    if (!queryId) return;

    const query = useQueryStore.getState().queue.find((q) => q.id === queryId);
    if (!query?.results) return;

    const csv = buildQueryCsv(query);
    if (!csv) return;

    // Sanitise display name for filename
    const safeName = query.displayName.replace(/[^a-zA-Z0-9_\-. ]/g, "_");
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
    handleBookmarkQuery,
    handleSaveBookmark,
    handleExportQuery,
  };
}

export type QueryUIHandlers = ReturnType<typeof useQueryUIHandlers>;

/** Format a byte value as "0xAA" */
function fmtByte(v: number): string {
  return `0x${v.toString(16).toUpperCase().padStart(2, "0")}`;
}

/** Build CSV string from a completed query's results */
function buildQueryCsv(query: QueuedQuery): string | null {
  const { queryType, results } = query;
  if (!results) return null;

  switch (queryType) {
    case "byte_changes": {
      const rows = (results as ByteChangeResult[]).map((r) => [
        r.timestamp_us,
        fmtByte(r.old_value),
        fmtByte(r.new_value),
      ]);
      return buildCsv(["timestamp_us", "old_value", "new_value"], rows);
    }

    case "frame_changes": {
      const rows = (results as FrameChangeResult[]).map((r) => [
        r.timestamp_us,
        r.changed_indices.length,
        r.changed_indices.join(" "),
        formatPayloadHex(r.old_payload),
        formatPayloadHex(r.new_payload),
      ]);
      return buildCsv(
        ["timestamp_us", "changed_count", "changed_indices", "old_payload", "new_payload"],
        rows,
      );
    }

    case "mirror_validation": {
      const rows = (results as MirrorValidationResult[]).map((r) => [
        r.mirror_timestamp_us,
        r.source_timestamp_us,
        r.mismatch_indices.length,
        r.mismatch_indices.join(" "),
        formatPayloadHex(r.mirror_payload),
        formatPayloadHex(r.source_payload),
      ]);
      return buildCsv(
        ["mirror_timestamp_us", "source_timestamp_us", "mismatch_count", "mismatch_indices", "mirror_payload", "source_payload"],
        rows,
      );
    }

    case "mux_statistics": {
      const mux = results as MuxStatisticsResult;
      const rows: (string | number)[][] = [];
      for (const c of mux.cases) {
        for (const b of c.byte_stats) {
          rows.push([
            c.mux_value,
            c.frame_count,
            b.byte_index,
            b.min,
            b.max,
            Number(b.avg.toFixed(2)),
            b.distinct_count,
            b.sample_count,
          ]);
        }
      }
      return buildCsv(
        ["mux_value", "frame_count", "byte_index", "min", "max", "avg", "distinct_count", "sample_count"],
        rows,
      );
    }

    case "first_last": {
      const fl = results as FirstLastResult;
      const rows: (string | number)[][] = [
        ["first", fl.first_timestamp_us, formatPayloadHex(fl.first_payload)],
        ["last", fl.last_timestamp_us, formatPayloadHex(fl.last_payload)],
      ];
      return buildCsv(
        ["position", "timestamp_us", "payload"],
        rows,
      ) + `\ntotal_count,${fl.total_count}\n`;
    }

    case "frequency": {
      const rows = (results as FrequencyBucket[]).map((r) => [
        r.bucket_start_us,
        r.frame_count,
        r.min_interval_us,
        r.max_interval_us,
        Number(r.avg_interval_us.toFixed(2)),
      ]);
      return buildCsv(
        ["bucket_start_us", "frame_count", "min_interval_us", "max_interval_us", "avg_interval_us"],
        rows,
      );
    }

    case "distribution": {
      const rows = (results as DistributionResult[]).map((r) => [
        fmtByte(r.value),
        r.count,
        Number(r.percentage.toFixed(2)),
      ]);
      return buildCsv(["value", "count", "percentage"], rows);
    }

    case "gap_analysis": {
      const rows = (results as GapResult[]).map((r) => [
        r.gap_start_us,
        r.gap_end_us,
        Number(r.duration_ms.toFixed(3)),
      ]);
      return buildCsv(["gap_start_us", "gap_end_us", "duration_ms"], rows);
    }

    case "pattern_search": {
      const rows = (results as PatternSearchResult[]).map((r) => [
        r.timestamp_us,
        r.frame_id,
        r.is_extended ? "true" : "false",
        formatPayloadHex(r.payload),
        r.match_positions.join(" "),
      ]);
      return buildCsv(
        ["timestamp_us", "frame_id", "is_extended", "payload", "match_positions"],
        rows,
      );
    }

    default:
      return null;
  }
}
