// ui/src/api/capture.ts
//
// API wrappers for the multi-capture registry system.
// Supports multiple named captures with typed storage (frames or bytes).

import { invoke } from "@tauri-apps/api/core";
import type { IOCapabilities } from "./io";

/**
 * Capture kind - determines what kind of data is stored
 */
export type CaptureKind = "frames" | "bytes";

/**
 * Metadata about a capture in the registry
 */
export interface CaptureMetadata {
  /** Unique capture ID (e.g., "xk9m2p", "r7f3kw") */
  id: string;
  /** Kind of data stored: "frames" (CAN, framed serial) or "bytes" (raw serial) */
  kind: CaptureKind;
  /** Display name (e.g., "GVRET 10:30am", "Serial dump") */
  name: string;
  /** Number of items (frames for frame captures, bytes for byte captures) */
  count: number;
  /** Timestamp of first item (microseconds) */
  start_time_us: number | null;
  /** Timestamp of last item (microseconds) */
  end_time_us: number | null;
  /** When the capture was created (Unix timestamp in seconds) */
  created_at: number;
  /** Whether this capture is actively receiving data (is the streaming target) */
  is_streaming: boolean;
  /**
   * Session ID that owns this capture (null = orphaned, available for standalone use).
   * Captures with an owning session are only accessible through that session.
   * When a session is destroyed, the capture is orphaned.
   */
  owning_session_id: string | null;
  /** Whether this capture survives app restart when 'clear captures on start' is enabled */
  persistent: boolean;
  /** Distinct bus numbers present in this capture's data (sorted) */
  buses: number[];
}

/**
 * Import a CSV file into the shared buffer.
 * The buffer can then be used by any app (Discovery, Decoder).
 *
 * @param filePath - Full path to the CSV file
 * @returns Metadata about the imported data
 */
export async function importCsvToCapture(sessionId: string, filePath: string): Promise<CaptureMetadata> {
  return invoke("import_csv_to_capture", { session_id: sessionId, file_path: filePath });
}

// ============================================================================
// Flexible CSV Import API (column mapping)
// ============================================================================

/** A gap detected in the sequence column during CSV import */
export interface SequenceGap {
  /** Line number in the CSV file where the gap starts (1-based) */
  line: number;
  /** Sequence value before the gap */
  from_seq: number;
  /** Sequence value after the gap */
  to_seq: number;
  /** Estimated number of dropped frames */
  dropped: number;
  /** Filename (set for multi-file imports) */
  filename?: string;
}

/** Result of a CSV import, including buffer metadata and sequence diagnostics */
export interface CsvImportResult {
  metadata: CaptureMetadata;
  sequence_gaps: SequenceGap[];
  /** Total number of dropped frames estimated from sequence gaps */
  total_dropped: number;
  /** Detected sequence wraparound points (raw sequence value at each wrap) */
  wrap_points: number[];
}

/**
 * Column delimiter for splitting lines into fields
 */
export type Delimiter = "comma" | "tab" | "space" | "semicolon";

/**
 * Column role for CSV mapping
 */
export type CsvColumnRole =
  | "ignore"
  | "frame_id"
  | "timestamp"
  | "data_bytes"
  | "data_byte"
  | "dlc"
  | "extended"
  | "bus"
  | "direction"
  | "frame_id_data"
  | "sequence";

/**
 * A single column mapping: column index to role
 */
export interface CsvColumnMapping {
  column_index: number;
  role: CsvColumnRole;
}

/**
 * Timestamp unit for CSV import
 */
export type TimestampUnit =
  | "seconds"
  | "milliseconds"
  | "microseconds"
  | "nanoseconds";

/**
 * Preview data from a CSV file
 */
export interface CsvPreview {
  /** Header strings if first row is a header */
  headers: string[] | null;
  /** Preview data rows (raw cell strings) */
  rows: string[][];
  /** Total number of data rows in the file */
  total_rows: number;
  /** Auto-detected column mappings */
  suggested_mappings: CsvColumnMapping[];
  /** Whether the first row was detected as a header */
  has_header: boolean;
  /** Auto-detected timestamp unit based on sample data analysis */
  suggested_timestamp_unit: TimestampUnit;
  /** Whether sample timestamps are all negative (suggests negate fix) */
  has_negative_timestamps: boolean;
  /** Detected or user-specified delimiter */
  delimiter: Delimiter;
}

/**
 * Preview a data file: reads first N rows, detects delimiter/headers, suggests column mappings.
 *
 * @param filePath - Full path to the data file
 * @param maxRows - Maximum preview rows (default: 20)
 * @param delimiter - Column delimiter (auto-detected if not specified)
 * @returns Preview data with suggested mappings
 */
export async function previewCsv(
  filePath: string,
  maxRows?: number,
  delimiter?: Delimiter | null
): Promise<CsvPreview> {
  return invoke("preview_csv", {
    file_path: filePath,
    max_rows: maxRows ?? null,
    delimiter: delimiter ?? null,
  });
}

/**
 * Import a data file with user-provided column mappings.
 *
 * @param filePath - Full path to the data file
 * @param mappings - Column role assignments
 * @param skipFirstRow - Whether to skip the first row (header)
 * @param delimiter - Column delimiter
 * @returns Buffer metadata for the imported data
 */
export async function importCsvWithMapping(
  sessionId: string,
  filePath: string,
  mappings: CsvColumnMapping[],
  skipFirstRow: boolean,
  timestampUnit: TimestampUnit,
  negateTimestamps: boolean,
  delimiter: Delimiter
): Promise<CsvImportResult> {
  return invoke("import_csv_with_mapping", {
    session_id: sessionId,
    file_path: filePath,
    mappings,
    skip_first_row: skipFirstRow,
    timestamp_unit: timestampUnit,
    negate_timestamps: negateTimestamps,
    delimiter,
  });
}

/**
 * Import multiple data files with shared column mappings into a single buffer.
 * Files are parsed sequentially and concatenated in order.
 *
 * @param filePaths - Ordered list of file paths to import
 * @param mappings - Column role assignments (applied to all files)
 * @param skipFirstRowPerFile - Per-file flag: whether to skip the first row (header)
 * @param timestampUnit - Timestamp unit for all files
 * @param negateTimestamps - Whether to negate timestamps
 * @param delimiter - Column delimiter
 * @returns Buffer metadata for the merged data
 */
export async function importCsvBatchWithMapping(
  sessionId: string,
  filePaths: string[],
  mappings: CsvColumnMapping[],
  skipFirstRowPerFile: boolean[],
  timestampUnit: TimestampUnit,
  negateTimestamps: boolean,
  delimiter: Delimiter
): Promise<CsvImportResult> {
  return invoke("import_csv_batch_with_mapping", {
    session_id: sessionId,
    file_paths: filePaths,
    mappings,
    skip_first_row_per_file: skipFirstRowPerFile,
    timestamp_unit: timestampUnit,
    negate_timestamps: negateTimestamps,
    delimiter,
  });
}

/**
 * Get metadata for a specific buffer.
 * Returns null if the buffer doesn't exist.
 *
 * @param captureId - The buffer ID to look up
 */
export async function getCaptureMetadata(captureId: string): Promise<CaptureMetadata | null> {
  return invoke("get_capture_metadata", { capture_id: captureId });
}

/**
 * A single CAN frame from the buffer.
 */
export interface CaptureFrame {
  protocol: string;
  timestamp_us: number;
  frame_id: number;
  bus: number;
  dlc: number;
  bytes: number[];
  is_extended?: boolean;
  is_fd?: boolean;
  /** Source address (for protocols like J1939, TWC that embed sender ID in frame) */
  source_address?: number;
}

/**
 * Get all frames from the shared buffer.
 * Returns an empty array if no data is loaded.
 * WARNING: For large buffers (>100k frames), use getCaptureFramesPaginated instead.
 */
export async function getCaptureFrames(captureId: string): Promise<CaptureFrame[]> {
  return invoke("get_capture_frames", { capture_id: captureId });
}

/**
 * Response for paginated buffer frames
 */
export interface PaginatedFramesResponse {
  frames: CaptureFrame[];
  total_count: number;
  offset: number;
  limit: number;
  /** 1-based original capture position (rowid) for each frame, parallel to `frames`. */
  capture_indices: number[];
}

/**
 * Get a page of frames from the shared buffer.
 * Use this for large datasets to avoid IPC overload.
 *
 * @param offset - Starting index (0-based)
 * @param limit - Maximum number of frames to return
 */
export async function getCaptureFramesPaginated(
  captureId: string,
  offset: number,
  limit: number
): Promise<PaginatedFramesResponse> {
  return invoke("get_capture_frames_paginated", { capture_id: captureId, offset, limit });
}

/**
 * Get a page of frames from the shared buffer, filtered by selected frame IDs.
 * Use this when the user has selected specific frames in the frame picker.
 *
 * @param offset - Starting index (0-based) in the filtered result
 * @param limit - Maximum number of frames to return
 * @param selectedIds - Array of frame IDs to include (empty = all frames)
 */
export async function getCaptureFramesPaginatedFiltered(
  captureId: string,
  offset: number,
  limit: number,
  selectedIds: number[]
): Promise<PaginatedFramesResponse> {
  return invoke("get_capture_frames_paginated_filtered", {
    capture_id: captureId,
    offset,
    limit,
    selected_ids: selectedIds,
  });
}

/**
 * Response for tail buffer frames
 */
export interface TailResponse {
  frames: CaptureFrame[];
  /** 1-based original capture position (rowid) for each frame, parallel to `frames`. */
  capture_indices: number[];
  total_filtered_count: number;
  capture_end_time_us: number | null;
}

/**
 * Get the most recent N frames from the active buffer, optionally filtered by frame IDs.
 * Used for "tail mode" during streaming - shows latest frames without frontend accumulation.
 *
 * @param limit - Maximum number of frames to return
 * @param selectedIds - Array of frame IDs to filter by (empty = all frames)
 */
export async function getCaptureFramesTail(
  captureId: string,
  limit: number,
  selectedIds: number[]
): Promise<TailResponse> {
  return invoke("get_capture_frames_tail", {
    capture_id: captureId,
    limit,
    selected_ids: selectedIds,
  });
}

/**
 * Get a page of frames from a specific buffer by ID.
 * Use this to fetch frames from a derived buffer (e.g., framing results).
 *
 * @param captureId - The buffer ID
 * @param offset - Starting index (0-based)
 * @param limit - Maximum number of frames to return
 */
export async function getCaptureFramesPaginatedById(
  captureId: string,
  offset: number,
  limit: number
): Promise<PaginatedFramesResponse> {
  return invoke("get_capture_frames_paginated_by_id", {
    capture_id: captureId,
    offset,
    limit,
  });
}

/**
 * Frame info extracted from the buffer
 */
export interface CaptureFrameInfo {
  frame_id: number;
  max_dlc: number;
  bus: number;
  is_extended: boolean;
  has_dlc_mismatch: boolean;
}

/**
 * Get unique frame IDs and their metadata from the buffer.
 * Used to build the frame picker after a large ingest.
 */
export async function getCaptureFrameInfo(captureId: string): Promise<CaptureFrameInfo[]> {
  return invoke("get_capture_frame_info", { capture_id: captureId });
}

/**
 * Find the offset in the filtered buffer for a given timestamp.
 * Used for timeline scrubber navigation in buffer mode.
 *
 * @param timestampUs - Target timestamp in microseconds
 * @param selectedIds - Array of frame IDs to filter by (empty = all frames)
 * @returns Offset of the first frame at or after the given timestamp
 */
export async function findCaptureOffsetForTimestamp(
  captureId: string,
  timestampUs: number,
  selectedIds: number[]
): Promise<number> {
  return invoke("find_capture_offset_for_timestamp", {
    capture_id: captureId,
    timestamp_us: timestampUs,
    selected_ids: selectedIds,
  });
}

/**
 * Create a reader session for the shared buffer.
 * The buffer must have data loaded (via importCsvToCapture).
 *
 * @param sessionId - Unique session ID (e.g., "discovery", "decoder")
 * @param speed - Playback speed (0 = no limit, 1 = realtime)
 * @returns Reader capabilities
 */
export async function createCaptureSourceSession(
  sessionId: string,
  captureId: string,
  speed?: number
): Promise<IOCapabilities> {
  return invoke("create_capture_source_session", {
    session_id: sessionId,
    capture_id: captureId,
    speed,
  });
}

// ============================================================================
// Multi-Buffer Registry API
// ============================================================================

/**
 * List all buffers in the registry.
 * Returns metadata for all buffers (frame and byte types).
 */
export async function listCaptures(): Promise<CaptureMetadata[]> {
  return invoke("list_captures");
}

/**
 * List all known buffer IDs (lightweight — no metadata).
 * Used to populate the known buffer ID set for `isCaptureProfileId()` lookups.
 */
export async function listCaptureIds(): Promise<string[]> {
  return invoke("list_capture_ids");
}

/**
 * List only orphaned buffers (no owning session).
 * These are buffers available for standalone selection in the IO picker.
 * Includes CSV imports and buffers from destroyed sessions.
 */
export async function listOrphanedCaptures(): Promise<CaptureMetadata[]> {
  return invoke("list_orphaned_captures");
}

/**
 * Delete a specific buffer by ID.
 *
 * @param captureId - The buffer ID to delete
 */
export async function deleteCapture(captureId: string): Promise<void> {
  await invoke("delete_capture", { capture_id: captureId });
  // Remove from known buffer ID cache
  const { useSessionStore } = await import("../stores/sessionStore");
  useSessionStore.getState().removeKnownCaptureId(captureId);
}

/**
 * Clear a buffer's data without deleting the buffer itself.
 * The session keeps its reference and can continue writing new frames.
 *
 * @param captureId - The buffer ID to clear
 */
export async function clearCaptureData(captureId: string): Promise<void> {
  return invoke("clear_capture", { capture_id: captureId });
}

/**
 * Rename a buffer.
 *
 * @param captureId - The buffer ID to rename
 * @param newName - The new display name
 * @returns Updated buffer metadata
 */
export async function renameCapture(captureId: string, newName: string): Promise<CaptureMetadata> {
  return invoke("rename_capture", { capture_id: captureId, new_name: newName });
}

/**
 * Set a buffer's persistent (pinned) flag.
 * Persistent buffers survive app restart when 'clear buffers on start' is enabled.
 *
 * @param captureId - The buffer ID
 * @param persistent - Whether the buffer should be persistent
 * @returns Updated buffer metadata
 */
export async function setCapturePersistent(captureId: string, persistent: boolean): Promise<CaptureMetadata> {
  return invoke("set_capture_persistent", { capture_id: captureId, persistent });
}

/**
 * Get metadata for a specific buffer by ID.
 *
 * @param captureId - The buffer ID to look up
 * @returns Buffer metadata, or null if not found
 */
export async function getCaptureMetadataById(captureId: string): Promise<CaptureMetadata | null> {
  return invoke("get_capture_metadata_by_id", { capture_id: captureId });
}

/**
 * Get frames from a specific frame buffer by ID.
 * Throws if the buffer doesn't exist or is not a frame buffer.
 *
 * @param captureId - The buffer ID
 * @returns Array of frames
 */
export async function getCaptureFramesById(captureId: string): Promise<CaptureFrame[]> {
  return invoke("get_capture_frames_by_id", { capture_id: captureId });
}

/**
 * Timestamped byte for raw serial data
 */
export interface TimestampedByte {
  byte: number;
  timestamp_us: number;
  /** Bus/interface number (for multi-source sessions) */
  bus?: number;
}

/**
 * Get raw bytes from a specific byte buffer by ID.
 * Throws if the buffer doesn't exist or is not a byte buffer.
 *
 * @param captureId - The buffer ID
 * @returns Array of timestamped bytes
 */
export async function getCaptureBytesById(captureId: string): Promise<TimestampedByte[]> {
  return invoke("get_capture_bytes_by_id", { capture_id: captureId });
}

/**
 * Set a specific buffer as active (for legacy single-buffer compatibility).
 * The active buffer is used by functions like getCaptureFrames() and getCaptureMetadata().
 *
 * @param captureId - The buffer ID to set as active
 */
export async function setActiveCapture(captureId: string): Promise<void> {
  return invoke("set_active_capture", { capture_id: captureId });
}

/**
 * Create a new frame buffer from frames passed from the frontend.
 * Used when accepting client-side framing to persist the framed data.
 *
 * @param name - Display name for the buffer
 * @param frames - Array of frames to store
 * @returns Metadata of the created buffer
 */
export async function createFrameCaptureFromFrames(
  sessionId: string,
  name: string,
  frames: CaptureFrame[]
): Promise<CaptureMetadata> {
  return invoke("create_frame_capture_from_frames", { session_id: sessionId, name, frames });
}

// ============================================================================
// Byte Buffer API (Serial Discovery)
// ============================================================================

/**
 * Response for paginated buffer bytes
 */
export interface PaginatedBytesResponse {
  bytes: TimestampedByte[];
  total_count: number;
  offset: number;
  limit: number;
}

/**
 * Get a page of bytes from the active buffer.
 * Use this for large datasets to avoid IPC overload.
 *
 * @param offset - Starting index (0-based)
 * @param limit - Maximum number of bytes to return
 */
export async function getCaptureBytesPaginated(
  captureId: string,
  offset: number,
  limit: number
): Promise<PaginatedBytesResponse> {
  return invoke("get_capture_bytes_paginated", { capture_id: captureId, offset, limit });
}

/**
 * Get the total byte count from the active buffer.
 */
export async function getCaptureBytesCount(captureId: string): Promise<number> {
  return invoke("get_capture_bytes_count", { capture_id: captureId });
}

/**
 * Get a page of bytes from a specific buffer by ID.
 *
 * @param captureId - The buffer ID
 * @param offset - Starting index (0-based)
 * @param limit - Maximum number of bytes to return
 */
export async function getCaptureBytesPaginatedById(
  captureId: string,
  offset: number,
  limit: number
): Promise<PaginatedBytesResponse> {
  return invoke("get_capture_bytes_paginated_by_id", { capture_id: captureId, offset, limit });
}

// ============================================================================
// Backend Framing API
// ============================================================================

/**
 * Configuration for frame ID extraction from frame bytes.
 */
export interface FrameIdConfig {
  /** Start byte index (negative = from end) */
  start_byte: number;
  /** Number of bytes for frame ID (1 or 2) */
  num_bytes: number;
  /** Whether to interpret as big-endian */
  big_endian: boolean;
}

/**
 * Per-interface framing configuration (overrides default for specific bus).
 */
export interface InterfaceFramingConfig {
  /** Framing mode: "raw", "slip", "modbus_rtu" */
  mode: 'raw' | 'slip' | 'modbus_rtu';
  /** For raw mode: delimiter bytes as hex string (e.g., "0D0A") */
  delimiter?: string;
  /** For raw mode: max frame length before forced split */
  max_length?: number;
  /** For modbus_rtu mode: whether to validate CRC */
  validate_crc?: boolean;
}

/**
 * Configuration for backend framing.
 */
export interface BackendFramingConfig {
  /** Default framing mode: "raw", "slip", "modbus_rtu" */
  mode: 'raw' | 'slip' | 'modbus_rtu';
  /** For raw mode: delimiter bytes as hex string (e.g., "0D0A") */
  delimiter?: string;
  /** For raw mode: max frame length before forced split */
  max_length?: number;
  /** For modbus_rtu mode: whether to validate CRC */
  validate_crc?: boolean;
  /** Minimum frame length to accept (frames shorter are discarded) */
  min_length?: number;
  /** Frame ID extraction config */
  frame_id_config?: FrameIdConfig;
  /** Source address extraction config */
  source_address_config?: FrameIdConfig;
  /** Per-interface framing overrides (bus number -> config) */
  per_interface?: Record<number, InterfaceFramingConfig>;
}

/**
 * Result from backend framing operation.
 */
export interface FramingResult {
  /** Number of frames extracted */
  frame_count: number;
  /** ID of the new frame capture */
  capture_id: string;
  /** Number of frames excluded by min_length filter */
  filtered_count: number;
  /** ID of the filtered frames capture (frames that were too short) */
  filtered_capture_id: string | null;
}

/**
 * Apply framing to the active byte buffer.
 * If reuseBufferId is provided and valid, that buffer is cleared and reused.
 * Otherwise, a new frame buffer is created.
 * This avoids buffer proliferation during live framing.
 *
 * @param config - Framing configuration
 * @param reuseBufferId - Optional ID of existing framing buffer to reuse (avoids proliferation)
 * @returns Result with frame count and buffer ID (same as reuseBufferId if reused, or new ID)
 */
export async function applyFramingToCapture(
  sessionId: string,
  config: BackendFramingConfig,
  reuseBufferId?: string | null
): Promise<FramingResult> {
  return invoke("apply_framing_to_capture", {
    session_id: sessionId,
    config,
    reuse_capture_id: reuseBufferId ?? null,
  });
}

/**
 * Find the byte offset at or after the given timestamp in the active byte buffer.
 * Uses binary search for O(log n) performance.
 *
 * @param targetTimeUs - Target timestamp in microseconds
 * @returns Offset of the first byte at or after the given timestamp
 */
export async function findCaptureBytesOffsetForTimestamp(
  captureId: string,
  targetTimeUs: number
): Promise<number> {
  return invoke("find_capture_bytes_offset_for_timestamp", { capture_id: captureId, target_time_us: targetTimeUs });
}

/**
 * Search a frame buffer for frames matching a query string.
 * Returns 0-based offsets in the selected-ID-filtered result set.
 *
 * @param captureId - The buffer ID to search
 * @param query - Search string (whitespace already stripped by caller)
 * @param searchId - Whether to search the frame ID column
 * @param searchData - Whether to search the payload (data) column
 * @param selectedIds - Frame IDs to include (empty = all)
 */
export async function searchCaptureFrames(
  captureId: string,
  query: string,
  searchId: boolean,
  searchData: boolean,
  selectedIds: number[]
): Promise<number[]> {
  return invoke("search_capture_frames", {
    capture_id: captureId,
    query,
    search_id: searchId,
    search_data: searchData,
    selected_ids: selectedIds,
  });
}
