// src/api/dbquery.ts
//
// API wrappers for database query commands (Query app).

import { invoke } from "@tauri-apps/api/core";

/** Result of a byte change query */
export interface ByteChangeResult {
  timestamp_us: number;
  old_value: number;
  new_value: number;
}

/** Result of a frame change query */
export interface FrameChangeResult {
  timestamp_us: number;
  old_payload: number[];
  new_payload: number[];
  changed_indices: number[];
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

/** Wrapper for byte change query results with stats */
export interface ByteChangeQueryResult {
  results: ByteChangeResult[];
  stats: QueryStats;
}

/** Wrapper for frame change query results with stats */
export interface FrameChangeQueryResult {
  results: FrameChangeResult[];
  stats: QueryStats;
}

/** Result of a mirror validation query */
export interface MirrorValidationResult {
  mirror_timestamp_us: number;
  source_timestamp_us: number;
  mirror_payload: number[];
  source_payload: number[];
  mismatch_indices: number[];
}

/** Wrapper for mirror validation query results with stats */
export interface MirrorValidationQueryResult {
  results: MirrorValidationResult[];
  stats: QueryStats;
}

/**
 * Query for byte changes in a specific frame.
 *
 * Returns timestamps where the specified byte changed value.
 */
export async function queryByteChanges(
  profileId: string,
  frameId: number,
  byteIndex: number,
  isExtended: boolean | null,
  startTime?: string,
  endTime?: string,
  limit?: number,
  queryId?: string
): Promise<ByteChangeQueryResult> {
  return invoke("db_query_byte_changes", {
    profileId,
    frameId,
    byteIndex,
    isExtended,
    startTime,
    endTime,
    limit,
    queryId,
  });
}

/**
 * Query for frame payload changes.
 *
 * Returns timestamps where any byte in the frame's payload changed.
 */
export async function queryFrameChanges(
  profileId: string,
  frameId: number,
  isExtended: boolean | null,
  startTime?: string,
  endTime?: string,
  limit?: number,
  queryId?: string
): Promise<FrameChangeQueryResult> {
  return invoke("db_query_frame_changes", {
    profileId,
    frameId,
    isExtended,
    startTime,
    endTime,
    limit,
    queryId,
  });
}

/**
 * Query for mirror validation mismatches.
 *
 * Compares payloads between mirror and source frames at matching timestamps
 * (within tolerance). Returns timestamps where payloads differ.
 */
export async function queryMirrorValidation(
  profileId: string,
  mirrorFrameId: number,
  sourceFrameId: number,
  isExtended: boolean | null,
  toleranceMs: number,
  startTime?: string,
  endTime?: string,
  limit?: number,
  queryId?: string
): Promise<MirrorValidationQueryResult> {
  return invoke("db_query_mirror_validation", {
    profileId,
    mirrorFrameId,
    sourceFrameId,
    isExtended,
    toleranceMs,
    startTime,
    endTime,
    limit,
    queryId,
  });
}

/** Statistics for a single byte position within a mux case */
export interface BytePositionStats {
  byte_index: number;
  min: number;
  max: number;
  avg: number;
  distinct_count: number;
  sample_count: number;
}

/** Statistics for a reconstructed 16-bit value from two adjacent bytes */
export interface Word16Stats {
  start_byte: number;
  endianness: "le" | "be";
  min: number;
  max: number;
  avg: number;
  distinct_count: number;
}

/** Statistics for a single mux case */
export interface MuxCaseStats {
  mux_value: number;
  frame_count: number;
  byte_stats: BytePositionStats[];
  word16_stats: Word16Stats[];
}

/** Full result of a mux statistics query */
export interface MuxStatisticsResult {
  mux_byte: number;
  total_frames: number;
  cases: MuxCaseStats[];
}

/** Wrapper for mux statistics query results with stats */
export interface MuxStatisticsQueryResult {
  results: MuxStatisticsResult;
  stats: QueryStats;
}

/**
 * Query mux statistics for a multiplexed frame.
 *
 * Groups payloads by mux selector byte and computes per-byte and optional
 * 16-bit word statistics for each mux case.
 */
export async function queryMuxStatistics(
  profileId: string,
  frameId: number,
  muxSelectorByte: number,
  isExtended: boolean | null,
  include16bit: boolean,
  payloadLength: number,
  startTime?: string,
  endTime?: string,
  limit?: number,
  queryId?: string
): Promise<MuxStatisticsQueryResult> {
  return invoke("db_query_mux_statistics", {
    profileId,
    frameId,
    muxSelectorByte,
    isExtended,
    include16bit: include16bit,
    payloadLength,
    startTime,
    endTime,
    limit,
    queryId,
  });
}

// ── First/Last Occurrence ──

/** Result of a first/last occurrence query */
export interface FirstLastResult {
  first_timestamp_us: number;
  first_payload: number[];
  last_timestamp_us: number;
  last_payload: number[];
  total_count: number;
}

/** Wrapper for first/last query results with stats */
export interface FirstLastQueryResult {
  results: FirstLastResult;
  stats: QueryStats;
}

/**
 * Query for the first and last occurrence of a frame.
 */
export async function queryFirstLast(
  profileId: string,
  frameId: number,
  isExtended: boolean | null,
  startTime?: string,
  endTime?: string,
  queryId?: string,
): Promise<FirstLastQueryResult> {
  return invoke("db_query_first_last", {
    profileId,
    frameId,
    isExtended,
    startTime,
    endTime,
    queryId,
  });
}

// ── Frame Frequency ──

/** A single frequency bucket result */
export interface FrequencyBucket {
  bucket_start_us: number;
  frame_count: number;
  min_interval_us: number;
  max_interval_us: number;
  avg_interval_us: number;
}

/** Wrapper for frequency query results with stats */
export interface FrequencyQueryResult {
  results: FrequencyBucket[];
  stats: QueryStats;
}

/**
 * Query frame transmission frequency over time buckets.
 */
export async function queryFrequency(
  profileId: string,
  frameId: number,
  isExtended: boolean | null,
  bucketSizeMs: number,
  startTime?: string,
  endTime?: string,
  limit?: number,
  queryId?: string,
): Promise<FrequencyQueryResult> {
  return invoke("db_query_frequency", {
    profileId,
    frameId,
    isExtended,
    bucketSizeMs,
    startTime,
    endTime,
    limit,
    queryId,
  });
}

// ── Value Distribution ──

/** A single distribution result */
export interface DistributionResult {
  value: number;
  count: number;
  percentage: number;
}

/** Wrapper for distribution query results with stats */
export interface DistributionQueryResult {
  results: DistributionResult[];
  stats: QueryStats;
}

/**
 * Query byte value distribution for a specific byte in a frame.
 */
export async function queryDistribution(
  profileId: string,
  frameId: number,
  byteIndex: number,
  isExtended: boolean | null,
  startTime?: string,
  endTime?: string,
  queryId?: string,
): Promise<DistributionQueryResult> {
  return invoke("db_query_distribution", {
    profileId,
    frameId,
    byteIndex,
    isExtended,
    startTime,
    endTime,
    queryId,
  });
}

// ── Gap Analysis ──

/** A single gap result */
export interface GapResult {
  gap_start_us: number;
  gap_end_us: number;
  duration_ms: number;
}

/** Wrapper for gap analysis query results with stats */
export interface GapAnalysisQueryResult {
  results: GapResult[];
  stats: QueryStats;
}

/**
 * Query for transmission gaps longer than a threshold.
 */
export async function queryGapAnalysis(
  profileId: string,
  frameId: number,
  isExtended: boolean | null,
  gapThresholdMs: number,
  startTime?: string,
  endTime?: string,
  limit?: number,
  queryId?: string,
): Promise<GapAnalysisQueryResult> {
  return invoke("db_query_gap_analysis", {
    profileId,
    frameId,
    isExtended,
    gapThresholdMs,
    startTime,
    endTime,
    limit,
    queryId,
  });
}

// ── Pattern Search ──

/** A single pattern search result */
export interface PatternSearchResult {
  timestamp_us: number;
  frame_id: number;
  is_extended: boolean;
  payload: number[];
  match_positions: number[];
}

/** Wrapper for pattern search query results with stats */
export interface PatternSearchQueryResult {
  results: PatternSearchResult[];
  stats: QueryStats;
}

/**
 * Search for a byte pattern across all frame IDs.
 */
export async function queryPatternSearch(
  profileId: string,
  pattern: number[],
  patternMask: number[],
  startTime?: string,
  endTime?: string,
  limit?: number,
  queryId?: string,
): Promise<PatternSearchQueryResult> {
  return invoke("db_query_pattern_search", {
    profileId,
    pattern,
    patternMask,
    startTime,
    endTime,
    limit,
    queryId,
  });
}

/**
 * Cancel a running database query.
 *
 * Sends a cancel request to the PostgreSQL server to terminate the query.
 */
export async function cancelQuery(queryId: string): Promise<void> {
  return invoke("db_cancel_query", { queryId });
}

/** A running query or session from pg_stat_activity */
export interface DatabaseActivity {
  /** Process ID (pid) of the backend */
  pid: number;
  /** Database name */
  database: string | null;
  /** Username */
  username: string | null;
  /** Application name (e.g., "CANdor Query") */
  application_name: string | null;
  /** Client address */
  client_addr: string | null;
  /** Current state (active, idle, idle in transaction, etc.) */
  state: string | null;
  /** Current query text (truncated) */
  query: string | null;
  /** When the query started (ISO 8601) */
  query_start: string | null;
  /** How long the query has been running in seconds */
  duration_secs: number | null;
  /** Whether this is a query we can cancel */
  is_cancellable: boolean;
}

/** Result of querying database activity */
export interface DatabaseActivityResult {
  /** Active queries running on the database */
  queries: DatabaseActivity[];
  /** Active sessions connected to the database */
  sessions: DatabaseActivity[];
}

/**
 * Query pg_stat_activity for running queries and active sessions.
 *
 * Returns information about queries currently running on the database
 * and all active sessions (connections).
 */
export async function queryActivity(
  profileId: string
): Promise<DatabaseActivityResult> {
  return invoke("db_query_activity", { profileId });
}

/**
 * Cancel a running query by backend PID using pg_cancel_backend.
 *
 * This sends a SIGINT to the backend process, which will cancel the current query
 * but keep the connection alive.
 *
 * @returns true if the cancel signal was sent successfully
 */
export async function cancelBackend(
  profileId: string,
  pid: number
): Promise<boolean> {
  return invoke("db_cancel_backend", { profileId, pid });
}

/**
 * Terminate a backend session by PID using pg_terminate_backend.
 *
 * This terminates the entire connection, not just the current query.
 * Use with caution.
 *
 * @returns true if the terminate signal was sent successfully
 */
export async function terminateBackend(
  profileId: string,
  pid: number
): Promise<boolean> {
  return invoke("db_terminate_backend", { profileId, pid });
}
