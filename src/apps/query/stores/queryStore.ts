// src/apps/query/stores/queryStore.ts
//
// Zustand store for the Query app. Manages query configuration, execution state,
// results display, and query queue.

import { create } from "zustand";
import {
  queryByteChanges,
  queryFrameChanges,
  queryMirrorValidation,
  cancelQuery,
  queryActivity,
  cancelBackend,
  terminateBackend,
  type DatabaseActivity,
  type DatabaseActivityResult,
} from "../../../api/dbquery";
import {
  queryByteChangesBuffer,
  queryFrameChangesBuffer,
  queryMirrorValidationBuffer,
} from "../../../api/bufferquery";
import type { TimeBounds } from "../../../components/TimeBoundsInput";
import { useSettingsStore } from "../../settings/stores/settingsStore";
import type { ParsedCatalog } from "../../../utils/catalogParser";

export type { DatabaseActivity, DatabaseActivityResult };

/** Available query types */
export type QueryType =
  | "byte_changes"
  | "frame_changes"
  | "mirror_validation"
  | "first_last"
  | "frequency"
  | "distribution"
  | "gap_analysis"
  | "pattern_search";

/** Query type metadata for UI display */
export const QUERY_TYPE_INFO: Record<QueryType, { label: string; description: string }> = {
  byte_changes: {
    label: "Byte Changes",
    description: "Find when a specific byte in a frame changed value",
  },
  frame_changes: {
    label: "Frame Changes",
    description: "Find when any byte in a frame's payload changed",
  },
  mirror_validation: {
    label: "Mirror Validation",
    description: "Find timestamps where mirror frames don't match their source",
  },
  first_last: {
    label: "First/Last Occurrence",
    description: "Find the first or last occurrence of a frame matching a pattern",
  },
  frequency: {
    label: "Frame Frequency",
    description: "Analyse transmission frequency over time",
  },
  distribution: {
    label: "Value Distribution",
    description: "Find all unique values for a byte range",
  },
  gap_analysis: {
    label: "Gap Analysis",
    description: "Find transmission gaps longer than a threshold",
  },
  pattern_search: {
    label: "Pattern Search",
    description: "Search for a byte pattern across all frame IDs",
  },
};

/** A single byte change result */
export interface ByteChangeResult {
  timestamp_us: number;
  old_value: number;
  new_value: number;
}

/** A single frame change result */
export interface FrameChangeResult {
  timestamp_us: number;
  old_payload: number[];
  new_payload: number[];
  changed_indices: number[];
}

/** A single mirror validation result */
export interface MirrorValidationResult {
  mirror_timestamp_us: number;
  source_timestamp_us: number;
  mirror_payload: number[];
  source_payload: number[];
  mismatch_indices: number[];
}

/** Query statistics returned with results */
export interface QueryStats {
  /** Number of rows fetched from the database */
  rows_scanned: number;
  /** Number of results after filtering */
  results_count: number;
  /** Query execution time in milliseconds */
  execution_time_ms: number;
}

/** Union type for query results */
export type QueryResult = ByteChangeResult[] | FrameChangeResult[] | MirrorValidationResult[];

/** Query parameters */
export interface QueryParams {
  frameId: number;
  /** Extended frame filter: true = extended only, false = standard only, null = no filter (both) */
  isExtended: boolean | null;
  byteIndex: number;
  // Mirror validation params
  mirrorFrameId: number;
  sourceFrameId: number;
  toleranceMs: number;
}

/** Context window configuration for ingesting around events */
export interface ContextWindow {
  beforeMs: number;
  afterMs: number;
}

/** Preset context windows */
export const CONTEXT_PRESETS: { label: string; beforeMs: number; afterMs: number }[] = [
  { label: "±1s", beforeMs: 1000, afterMs: 1000 },
  { label: "±5s", beforeMs: 5000, afterMs: 5000 },
  { label: "±30s", beforeMs: 30000, afterMs: 30000 },
  { label: "±1m", beforeMs: 60000, afterMs: 60000 },
];

/** Queue item status */
export type QueryStatus = "pending" | "running" | "completed" | "error";

/** Time bounds for query (from manual entry or bookmark) */
export interface QueryTimeBounds {
  startTime: string;
  endTime: string;
  maxFrames?: number;
  /** Display name (from bookmark, if selected) */
  favouriteName?: string;
}

/** A queued query with its configuration and results */
export interface QueuedQuery {
  /** Unique identifier for this queue item */
  id: string;
  /** Query type (byte_changes, frame_changes, etc.) */
  queryType: QueryType;
  /** Query parameters at time of submission */
  queryParams: QueryParams;
  /** Profile ID for the database connection (PostgreSQL queries) */
  profileId: string;
  /** Buffer ID for buffer queries (when set, routes to SQLite instead of PostgreSQL) */
  bufferId?: string;
  /** Current status */
  status: QueryStatus;
  /** When the query was submitted */
  submittedAt: number;
  /** When the query started running */
  startedAt?: number;
  /** When the query completed */
  completedAt?: number;
  /** Error message if status is 'error' */
  errorMessage?: string;
  /** Query results (null until completed) */
  results: QueryResult | null;
  /** Query statistics (null until completed) */
  stats: QueryStats | null;
  /** Display name for the query (auto-generated) */
  displayName: string;
  /** Time bounds from favourite (optional) */
  timeBounds?: QueryTimeBounds;
  /** Result limit for this query */
  resultLimit: number;
}

/** Format frame ID with leading zeros (3 digits for standard, 8 for extended) */
function formatFrameId(frameId: number, isExtended: boolean | null): string {
  // When isExtended is null (no filter), default to standard display (3 digits)
  const hexDigits = isExtended === true ? 8 : 3;
  return `0x${frameId.toString(16).toUpperCase().padStart(hexDigits, "0")}`;
}

/** Generate a display name for a query */
function generateQueryDisplayName(queryType: QueryType, queryParams: QueryParams, timeBounds?: QueryTimeBounds): string {
  const typeLabel = QUERY_TYPE_INFO[queryType].label;

  let name: string;
  if (queryType === "mirror_validation") {
    const mirrorHex = formatFrameId(queryParams.mirrorFrameId, queryParams.isExtended);
    const sourceHex = formatFrameId(queryParams.sourceFrameId, queryParams.isExtended);
    name = `${typeLabel} - ${mirrorHex} ↔ ${sourceHex}`;
  } else {
    const frameHex = formatFrameId(queryParams.frameId, queryParams.isExtended);
    name = `${typeLabel} - ${frameHex}`;
    if (queryType === "byte_changes") {
      name += ` [byte ${queryParams.byteIndex}]`;
    }
    if (queryParams.isExtended) {
      name += " (ext)";
    }
  }
  if (timeBounds) {
    name += ` · ${timeBounds.favouriteName}`;
  }
  return name;
}

export { formatFrameId };

/** Selected signal from catalog for query targeting */
export interface SelectedSignal {
  frameId: number;
  signalName: string;
  startBit: number;
  bitLength: number;
  byteIndex: number; // Derived: Math.floor(startBit / 8)
}

interface QueryState {
  // Profile state (synced with session manager)
  ioProfile: string | null;

  // Query configuration
  queryType: QueryType;
  queryParams: QueryParams;

  // Context window for ingest
  contextWindow: ContextWindow;

  // Query execution state (for backwards compat - now managed via queue)
  isRunning: boolean;
  error: string | null;

  // Results (legacy - now managed via queue)
  results: QueryResult | null;
  resultCount: number;
  lastQueryStats: QueryStats | null;

  // Queue state
  queue: QueuedQuery[];
  selectedQueryId: string | null;
  selectedFavouriteId: string | null;

  // Catalog state
  catalogPath: string | null;
  parsedCatalog: ParsedCatalog | null;
  selectedSignal: SelectedSignal | null;

  // Database activity state (Stats tab)
  activity: {
    queries: DatabaseActivity[];
    sessions: DatabaseActivity[];
    isLoading: boolean;
    error: string | null;
    lastRefresh: number | null;
  };

  // Actions
  setIoProfile: (profile: string | null) => void;
  setQueryType: (type: QueryType) => void;
  updateQueryParams: (params: Partial<QueryParams>) => void;
  setContextWindow: (window: ContextWindow) => void;
  setIsRunning: (running: boolean) => void;
  setError: (error: string | null) => void;
  setResults: (results: QueryResult | null, stats?: QueryStats) => void;
  clearResults: () => void;
  reset: () => void;

  // Queue actions
  enqueueQuery: (sourceId: string, sourceType: "postgres" | "buffer", timeBounds?: TimeBounds | null, resultLimit?: number) => string;
  updateQueueItem: (id: string, updates: Partial<QueuedQuery>) => void;
  removeQueueItem: (id: string) => void;
  clearQueue: () => void;
  setSelectedQueryId: (id: string | null) => void;
  setSelectedFavouriteId: (id: string | null) => void;
  processNextQuery: () => Promise<void>;

  // Catalog actions
  setCatalogPath: (path: string | null) => void;
  setParsedCatalog: (catalog: ParsedCatalog | null) => void;
  setSelectedSignal: (signal: SelectedSignal | null) => void;

  // Activity actions (Stats tab)
  refreshActivity: (profileId: string) => Promise<void>;
  cancelRunningQuery: (profileId: string, pid: number) => Promise<boolean>;
  terminateSession: (profileId: string, pid: number) => Promise<boolean>;
}

const initialQueryParams: QueryParams = {
  frameId: 0,
  isExtended: null, // No filter by default (query both standard and extended)
  byteIndex: 0,
  mirrorFrameId: 0,
  sourceFrameId: 0,
  toleranceMs: 50,
};

const initialContextWindow: ContextWindow = {
  beforeMs: 5000,
  afterMs: 5000,
};

export const useQueryStore = create<QueryState>((set, get) => ({
  // Initial state
  ioProfile: null,
  queryType: "byte_changes",
  queryParams: initialQueryParams,
  contextWindow: initialContextWindow,
  isRunning: false,
  error: null,
  results: null,
  resultCount: 0,
  lastQueryStats: null,

  // Queue state
  queue: [],
  selectedQueryId: null,
  selectedFavouriteId: null,

  // Catalog state
  catalogPath: null,
  parsedCatalog: null,
  selectedSignal: null,

  // Activity state (Stats tab)
  activity: {
    queries: [],
    sessions: [],
    isLoading: false,
    error: null,
    lastRefresh: null,
  },

  // Actions
  setIoProfile: (profile) => set({ ioProfile: profile }),

  setQueryType: (type) => set({ queryType: type, results: null, resultCount: 0, lastQueryStats: null, error: null }),

  updateQueryParams: (params) =>
    set((state) => ({
      queryParams: { ...state.queryParams, ...params },
    })),

  setContextWindow: (window) => set({ contextWindow: window }),

  setIsRunning: (running) => set({ isRunning: running }),

  setError: (error) => set({ error, isRunning: false }),

  setResults: (results, stats) =>
    set({
      results,
      resultCount: Array.isArray(results) ? results.length : 0,
      lastQueryStats: stats ?? null,
      isRunning: false,
      error: null,
    }),

  clearResults: () => set({ results: null, resultCount: 0, lastQueryStats: null, error: null }),

  reset: () =>
    set({
      queryType: "byte_changes",
      queryParams: initialQueryParams,
      contextWindow: initialContextWindow,
      isRunning: false,
      error: null,
      results: null,
      resultCount: 0,
      lastQueryStats: null,
      queue: [],
      selectedQueryId: null,
      selectedFavouriteId: null,
      catalogPath: null,
      parsedCatalog: null,
      selectedSignal: null,
    }),

  // Queue actions
  enqueueQuery: (sourceId: string, sourceType: "postgres" | "buffer", inputBounds?: TimeBounds | null, resultLimit?: number) => {
    const { queryType, queryParams } = get();
    const id = `query_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;

    // Convert TimeBounds to QueryTimeBounds (only if times are set)
    const timeBounds: QueryTimeBounds | undefined =
      inputBounds?.startTime || inputBounds?.endTime
        ? {
            startTime: inputBounds.startTime,
            endTime: inputBounds.endTime,
            maxFrames: inputBounds.maxFrames,
          }
        : undefined;

    const displayName = generateQueryDisplayName(queryType, queryParams, timeBounds);

    // Use provided limit or fall back to settings
    const limit = resultLimit ?? useSettingsStore.getState().buffers.queryResultLimit;

    const newItem: QueuedQuery = {
      id,
      queryType,
      queryParams: { ...queryParams },
      profileId: sourceType === "postgres" ? sourceId : "",
      bufferId: sourceType === "buffer" ? sourceId : undefined,
      status: "pending",
      submittedAt: Date.now(),
      results: null,
      stats: null,
      displayName,
      timeBounds,
      resultLimit: limit,
    };

    set((state) => ({
      queue: [...state.queue, newItem],
    }));

    // Auto-start processing if nothing is running
    setTimeout(() => get().processNextQuery(), 0);

    return id;
  },

  updateQueueItem: (id: string, updates: Partial<QueuedQuery>) => {
    set((state) => ({
      queue: state.queue.map((item) =>
        item.id === id ? { ...item, ...updates } : item
      ),
    }));
  },

  removeQueueItem: (id: string) => {
    const { queue } = get();
    const item = queue.find((q) => q.id === id);

    // If the query is running, cancel it on the backend
    if (item?.status === "running") {
      cancelQuery(id).catch((e) => {
        console.warn(`Failed to cancel query ${id}:`, e);
      });
    }

    set((state) => ({
      queue: state.queue.filter((q) => q.id !== id),
      selectedQueryId: state.selectedQueryId === id ? null : state.selectedQueryId,
    }));
  },

  clearQueue: () => {
    set({ queue: [], selectedQueryId: null });
  },

  setSelectedQueryId: (id: string | null) => {
    set({ selectedQueryId: id });
  },

  setSelectedFavouriteId: (id: string | null) => {
    set({ selectedFavouriteId: id });
  },

  processNextQuery: async () => {
    const { queue, updateQueueItem, setIsRunning } = get();

    // Check if anything is already running
    if (queue.some((q) => q.status === "running")) {
      return;
    }

    // Find next pending query
    const nextQuery = queue.find((q) => q.status === "pending");
    if (!nextQuery) {
      setIsRunning(false);
      return;
    }

    // Mark as running
    setIsRunning(true);
    updateQueueItem(nextQuery.id, {
      status: "running",
      startedAt: Date.now(),
    });

    try {
      let results: QueryResult = [];
      let stats: QueryStats | undefined;

      const { profileId, bufferId, queryType, queryParams, timeBounds, resultLimit } = nextQuery;

      if (bufferId) {
        // ── Buffer query path (SQLite) ──
        // Convert ISO time bounds to microseconds for buffer queries
        const toMicroseconds = (dt: string | undefined): number | undefined => {
          if (!dt) return undefined;
          try {
            const date = new Date(dt);
            if (isNaN(date.getTime())) return undefined;
            return date.getTime() * 1000;
          } catch {
            return undefined;
          }
        };

        const startTimeUs = toMicroseconds(timeBounds?.startTime);
        const endTimeUs = toMicroseconds(timeBounds?.endTime);

        switch (queryType) {
          case "byte_changes": {
            const response = await queryByteChangesBuffer(
              bufferId,
              queryParams.frameId,
              queryParams.byteIndex,
              queryParams.isExtended,
              startTimeUs,
              endTimeUs,
              resultLimit,
            );
            results = response.results;
            stats = response.stats;
            break;
          }

          case "frame_changes": {
            const response = await queryFrameChangesBuffer(
              bufferId,
              queryParams.frameId,
              queryParams.isExtended,
              startTimeUs,
              endTimeUs,
              resultLimit,
            );
            results = response.results;
            stats = response.stats;
            break;
          }

          case "mirror_validation": {
            const response = await queryMirrorValidationBuffer(
              bufferId,
              queryParams.mirrorFrameId,
              queryParams.sourceFrameId,
              queryParams.isExtended,
              queryParams.toleranceMs * 1000, // Convert ms → µs for buffer queries
              startTimeUs,
              endTimeUs,
              resultLimit,
            );
            results = response.results;
            stats = response.stats;
            break;
          }

          default:
            results = [];
            break;
        }
      } else {
        // ── PostgreSQL query path ──
        // Convert datetime-local format to ISO-8601 for the backend
        // datetime-local is "YYYY-MM-DDTHH:mm" but backend needs full ISO timestamp
        const toIsoTimestamp = (dt: string | undefined): string | undefined => {
          if (!dt) return undefined;
          try {
            // Parse as local time and convert to ISO
            const date = new Date(dt);
            if (isNaN(date.getTime())) return undefined;
            return date.toISOString();
          } catch {
            return undefined;
          }
        };

        // Only pass non-empty time bounds to the backend (empty strings cause serialization errors)
        const startTime = toIsoTimestamp(timeBounds?.startTime);
        const endTime = toIsoTimestamp(timeBounds?.endTime);

        switch (queryType) {
          case "byte_changes": {
            const response = await queryByteChanges(
              profileId,
              queryParams.frameId,
              queryParams.byteIndex,
              queryParams.isExtended,
              startTime,
              endTime,
              resultLimit,
              nextQuery.id
            );
            results = response.results;
            stats = response.stats;
            break;
          }

          case "frame_changes": {
            const response = await queryFrameChanges(
              profileId,
              queryParams.frameId,
              queryParams.isExtended,
              startTime,
              endTime,
              resultLimit,
              nextQuery.id
            );
            results = response.results;
            stats = response.stats;
            break;
          }

          case "mirror_validation": {
            const response = await queryMirrorValidation(
              profileId,
              queryParams.mirrorFrameId,
              queryParams.sourceFrameId,
              queryParams.isExtended,
              queryParams.toleranceMs,
              startTime,
              endTime,
              resultLimit,
              nextQuery.id
            );
            results = response.results;
            stats = response.stats;
            break;
          }

          default:
            // Other query types not yet implemented
            results = [];
            break;
        }
      }

      updateQueueItem(nextQuery.id, {
        status: "completed",
        completedAt: Date.now(),
        results,
        stats: stats ?? null,
      });
    } catch (e) {
      updateQueueItem(nextQuery.id, {
        status: "error",
        completedAt: Date.now(),
        errorMessage: e instanceof Error ? e.message : String(e),
      });
    }

    // Process next query in queue
    setTimeout(() => get().processNextQuery(), 0);
  },

  // Catalog actions
  setCatalogPath: (path: string | null) => {
    set({ catalogPath: path });
  },

  setParsedCatalog: (catalog: ParsedCatalog | null) => {
    set({ parsedCatalog: catalog, selectedSignal: null });
  },

  setSelectedSignal: (signal: SelectedSignal | null) => {
    if (signal) {
      // Auto-update query params when signal is selected
      set((state) => ({
        selectedSignal: signal,
        queryParams: {
          ...state.queryParams,
          frameId: signal.frameId,
          byteIndex: signal.byteIndex,
        },
      }));
    } else {
      set({ selectedSignal: null });
    }
  },

  // Activity actions (Stats tab)
  refreshActivity: async (profileId: string) => {
    set((state) => ({
      activity: { ...state.activity, isLoading: true, error: null },
    }));

    try {
      const result = await queryActivity(profileId);
      set({
        activity: {
          queries: result.queries,
          sessions: result.sessions,
          isLoading: false,
          error: null,
          lastRefresh: Date.now(),
        },
      });
    } catch (e) {
      set((state) => ({
        activity: {
          ...state.activity,
          isLoading: false,
          error: e instanceof Error ? e.message : String(e),
        },
      }));
    }
  },

  cancelRunningQuery: async (profileId: string, pid: number) => {
    try {
      const success = await cancelBackend(profileId, pid);
      if (success) {
        // Refresh activity to show updated state
        setTimeout(() => get().refreshActivity(profileId), 500);
      }
      return success;
    } catch (e) {
      console.error("Failed to cancel query:", e);
      return false;
    }
  },

  terminateSession: async (profileId: string, pid: number) => {
    try {
      const success = await terminateBackend(profileId, pid);
      if (success) {
        // Refresh activity to show updated state
        setTimeout(() => get().refreshActivity(profileId), 500);
      }
      return success;
    } catch (e) {
      console.error("Failed to terminate session:", e);
      return false;
    }
  },
}));
