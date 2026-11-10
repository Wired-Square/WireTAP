// src/apps/query/stores/queryStore.ts
//
// Zustand store for the Query app: the form, the catalogue it reads, and this
// window's view of the queue Rust runs.

import i18n from "i18next";
import { create } from "@wired-square/store/react";
import { REFRESH_ACTIVITY_DELAY_MS } from "../../../constants";
import {
  queryActivity,
  cancelBackend,
  terminateBackend,
  type DatabaseActivity,
} from "../../../api/dbquery";
import {
  enqueueQuery as enqueue,
  getQueryResult,
  removeQuery,
  type QueryItem,
  type QueryOutcome,
  type QueryQueue,
  type QuerySource,
  type QuerySpec,
} from "../../../api/query";
import type { TimeBounds } from "../../../components/TimeBoundsInput";
import { useSettingsStore } from "../../settings/stores/settingsStore";
import { datetimeLocalToMicros } from "../../../utils/timeFormat";
import { formatFrameId } from "../../../utils/frameIds";
import type { Catalog, Frame } from "../../../types/catalogModel";
import { framesById } from "../../../utils/catalogFrames";

export type { DatabaseActivity };

export type QueryType = QuerySpec["type"];

export const QUERY_TYPES: readonly QueryType[] = [
  "byte_changes",
  "frame_changes",
  "mirror_validation",
  "mux_statistics",
  "first_last",
  "frequency",
  "distribution",
  "gap_analysis",
  "pattern_search",
  "frame_inventory",
];

export const queryTypeLabel = (type: QueryType) => i18n.t(`query:types.${type}.label`);

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
  // Mux statistics params
  muxSelectorByte: number;
  include16Bit: boolean;
  payloadLength: number;
  // Gap analysis params
  gapThresholdMs: number;
  // Frequency params
  bucketSizeMs: number;
  // Pattern search params
  pattern: number[];
  patternMask: number[];
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

/** Generate a display name for a query */
function generateQueryDisplayName(queryType: QueryType, queryParams: QueryParams): string {
  const typeLabel = queryTypeLabel(queryType);

  let name: string;
  if (queryType === "mirror_validation") {
    const mirrorHex = formatFrameId(queryParams.mirrorFrameId, "hex", queryParams.isExtended);
    const sourceHex = formatFrameId(queryParams.sourceFrameId, "hex", queryParams.isExtended);
    name = `${typeLabel} - ${mirrorHex} ↔ ${sourceHex}`;
  } else if (queryType === "frame_inventory") {
    name = typeLabel;
  } else if (queryType === "pattern_search") {
    const patternHex = queryParams.pattern
      .map((b, i) => (queryParams.patternMask[i] === 0 ? "??" : b.toString(16).toUpperCase().padStart(2, "0")))
      .join(" ");
    name = `${typeLabel} - ${patternHex}`;
  } else {
    const frameHex = formatFrameId(queryParams.frameId, "hex", queryParams.isExtended);
    name = `${typeLabel} - ${frameHex}`;
    if (queryType === "byte_changes" || queryType === "distribution") {
      name += ` ${i18n.t("query:queryName.byte", { index: queryParams.byteIndex })}`;
    } else if (queryType === "mux_statistics") {
      name += ` ${i18n.t("query:queryName.muxByte", { index: queryParams.muxSelectorByte })}`;
    } else if (queryType === "gap_analysis") {
      name += ` [>${queryParams.gapThresholdMs}ms]`;
    } else if (queryType === "frequency") {
      name += ` ${i18n.t("query:queryName.buckets", { ms: queryParams.bucketSizeMs })}`;
    }
    if (queryParams.isExtended) {
      name += ` ${i18n.t("query:queryName.extended")}`;
    }
  }
  return name;
}

/** Selected signal from catalog for query targeting */
export interface SelectedSignal {
  frameId: number;
  signalName: string;
  startBit: number;
  bitLength: number;
  byteIndex: number; // Derived: Math.floor(startBit / 8)
}

/**
 * The form as a spec: bounds read at the form's edge in its timezone, the limit
 * on the types that take one. Throws for a bound that is not a time or an empty
 * pattern, before anything is sent.
 */
export function buildQuerySpec(queryType: QueryType, p: QueryParams, bounds: TimeBounds | null, limit: number): QuerySpec {
  const mode = bounds?.timezoneMode ?? "local";
  const window = {
    start_us: datetimeLocalToMicros(bounds?.startTime ?? "", mode),
    end_us: datetimeLocalToMicros(bounds?.endTime ?? "", mode),
  };
  const frame = { frame_id: p.frameId, is_extended: p.isExtended, ...window };
  switch (queryType) {
    case "byte_changes":
      return { type: queryType, ...frame, byte_index: p.byteIndex, limit };
    case "frame_changes":
      return { type: queryType, ...frame, limit };
    case "mirror_validation":
      return {
        type: queryType,
        mirror_frame_id: p.mirrorFrameId,
        source_frame_id: p.sourceFrameId,
        is_extended: p.isExtended,
        ...window,
        tolerance_ms: p.toleranceMs,
        limit,
      };
    case "mux_statistics":
      return {
        type: queryType,
        ...frame,
        mux_selector_byte: p.muxSelectorByte,
        include_16bit: p.include16Bit,
        payload_length: p.payloadLength,
        limit,
      };
    case "first_last":
      return { type: queryType, ...frame };
    case "frequency":
      return { type: queryType, ...frame, bucket_size_ms: p.bucketSizeMs, limit };
    case "distribution":
      return { type: queryType, ...frame, byte_index: p.byteIndex };
    case "gap_analysis":
      return { type: queryType, ...frame, gap_threshold_ms: p.gapThresholdMs, limit };
    case "pattern_search":
      if (p.pattern.length === 0) throw new Error(i18n.t("query:errors.patternRequired"));
      return { type: queryType, ...window, pattern: p.pattern, pattern_mask: p.patternMask, limit };
    case "frame_inventory":
      return { type: queryType, ...window, limit };
  }
}

/** The types whose spec carries a result limit. */
export const takesLimit = (queryType: QueryType) =>
  !["first_last", "distribution"].includes(queryType);

interface QueryState {
  ioProfile: string | null;
  /** The capture Query was last on, to reopen once its session is gone */
  captureSourceId: string | null;

  queryType: QueryType;
  queryParams: QueryParams;
  contextWindow: ContextWindow;
  error: string | null;

  /** Rust's queue as last pushed, and the results fetched for it. */
  queue: QueryItem[];
  queueRevision: number;
  outcomes: Record<string, QueryOutcome>;
  selectedQueryId: string | null;

  catalogPath: string | null;
  catalog: Catalog | null;
  selectedSignal: SelectedSignal | null;

  // Database activity state (Stats tab)
  activity: {
    queries: DatabaseActivity[];
    sessions: DatabaseActivity[];
    isLoading: boolean;
    error: string | null;
    lastRefresh: number | null;
  };

  setIoProfile: (profile: string | null) => void;
  setCaptureSourceId: (captureId: string | null) => void;
  setQueryType: (type: QueryType) => void;
  updateQueryParams: (params: Partial<QueryParams>) => void;
  setContextWindow: (window: ContextWindow) => void;
  setError: (error: string | null) => void;

  enqueueQuery: (source: QuerySource, timeBounds: TimeBounds | null, resultLimit?: number) => Promise<void>;
  applyQueue: (queue: QueryQueue) => void;
  loadOutcome: (id: string) => Promise<void>;
  removeQueueItem: (id: string) => void;
  setSelectedQueryId: (id: string | null) => void;

  setCatalogPath: (path: string | null) => void;
  setCatalog: (catalog: Catalog | null) => void;
  setSelectedSignal: (signal: SelectedSignal | null) => void;

  refreshActivity: (profileId: string) => Promise<void>;
  cancelRunningQuery: (profileId: string, pid: number) => Promise<boolean>;
  terminateSession: (profileId: string, pid: number) => Promise<boolean>;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

const initialQueryParams: QueryParams = {
  frameId: 0,
  isExtended: null, // No filter by default (query both standard and extended)
  byteIndex: 0,
  mirrorFrameId: 0,
  sourceFrameId: 0,
  toleranceMs: 50,
  muxSelectorByte: 0,
  include16Bit: true,
  payloadLength: 8,
  gapThresholdMs: 100,
  bucketSizeMs: 1000,
  pattern: [],
  patternMask: [],
};

const initialContextWindow: ContextWindow = {
  beforeMs: 5000,
  afterMs: 5000,
};

export const useQueryStore = create<QueryState>((set, get) => ({
  ioProfile: null,
  captureSourceId: null,
  queryType: "byte_changes",
  queryParams: initialQueryParams,
  contextWindow: initialContextWindow,
  error: null,

  queue: [],
  queueRevision: -1,
  outcomes: {},
  selectedQueryId: null,

  catalogPath: null,
  catalog: null,
  selectedSignal: null,

  activity: {
    queries: [],
    sessions: [],
    isLoading: false,
    error: null,
    lastRefresh: null,
  },

  setIoProfile: (profile) => set({ ioProfile: profile }),
  setCaptureSourceId: (captureId) => set({ captureSourceId: captureId }),

  setQueryType: (type) => set({ queryType: type, error: null }),

  updateQueryParams: (params) =>
    set((state) => ({
      queryParams: { ...state.queryParams, ...params },
    })),

  setContextWindow: (window) => set({ contextWindow: window }),

  setError: (error) => set({ error }),

  enqueueQuery: async (source, timeBounds, resultLimit) => {
    const { queryType, queryParams, catalogPath } = get();
    const limit = resultLimit ?? useSettingsStore.getState().buffers.queryResultLimit;
    try {
      const spec = buildQuerySpec(queryType, queryParams, timeBounds, limit);
      await enqueue(generateQueryDisplayName(queryType, queryParams), {
        source,
        spec,
        ...(catalogPath ? { catalog_path: catalogPath } : {}),
      });
    } catch (e) {
      set({ error: message(e) });
    }
  },

  applyQueue: (queue) => {
    if (queue.revision <= get().queueRevision) return;
    const ids = new Set(queue.items.map((item) => item.id));
    set((state) => ({
      queue: queue.items,
      queueRevision: queue.revision,
      outcomes: Object.fromEntries(Object.entries(state.outcomes).filter(([id]) => ids.has(id))),
      selectedQueryId: state.selectedQueryId && ids.has(state.selectedQueryId) ? state.selectedQueryId : null,
    }));
  },

  loadOutcome: async (id) => {
    if (get().outcomes[id]) return;
    try {
      const outcome = await getQueryResult(id);
      set((state) => ({ outcomes: { ...state.outcomes, [id]: outcome } }));
    } catch (e) {
      console.warn(`Failed to read query ${id}:`, e);
    }
  },

  removeQueueItem: (id) => {
    removeQuery(id).catch((e) => console.warn(`Failed to remove query ${id}:`, e));
  },

  setSelectedQueryId: (id) => set({ selectedQueryId: id }),

  setCatalogPath: (path: string | null) => {
    set({ catalogPath: path });
  },
  setCatalog: (catalog: Catalog | null) => {
    const frames = catalog ? framesById(catalog) : new Map<number, Frame>();
    const { queryParams } = get();
    const lowestId = Math.min(...frames.keys());
    const frame = frames.has(queryParams.frameId) ? undefined : frames.get(lowestId);
    set({
      catalog,
      selectedSignal: null,
      ...(frame && { queryParams: { ...queryParams, frameId: lowestId, isExtended: frame.isExtended ?? false } }),
    });
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
        setTimeout(() => get().refreshActivity(profileId), REFRESH_ACTIVITY_DELAY_MS);
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
        setTimeout(() => get().refreshActivity(profileId), REFRESH_ACTIVITY_DELAY_MS);
      }
      return success;
    } catch (e) {
      console.error("Failed to terminate session:", e);
      return false;
    }
  },
}));
