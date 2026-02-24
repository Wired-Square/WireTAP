// ui/src/api/buffer.ts
//
// API wrappers for the multi-buffer registry system.
// Supports multiple named buffers with typed storage (frames or bytes).

import { invoke } from "@tauri-apps/api/core";
import type { IOCapabilities } from "./io";

/**
 * Buffer type - determines what kind of data is stored
 */
export type BufferType = "frames" | "bytes";

/**
 * Metadata about a buffer in the registry
 */
export interface BufferMetadata {
  /** Unique buffer ID (e.g., "buffer_1", "buffer_2") */
  id: string;
  /** Type of data stored: "frames" (CAN, framed serial) or "bytes" (raw serial) */
  buffer_type: BufferType;
  /** Display name (e.g., "GVRET 10:30am", "Serial dump") */
  name: string;
  /** Number of items (frames for frame buffers, bytes for byte buffers) */
  count: number;
  /** Timestamp of first item (microseconds) */
  start_time_us: number | null;
  /** Timestamp of last item (microseconds) */
  end_time_us: number | null;
  /** When the buffer was created (Unix timestamp in seconds) */
  created_at: number;
  /** Whether this buffer is actively receiving data (is the streaming target) */
  is_streaming: boolean;
  /**
   * Session ID that owns this buffer (null = orphaned, available for standalone use).
   * Buffers with an owning session are only accessible through that session.
   * When a session is destroyed, the buffer is orphaned.
   */
  owning_session_id: string | null;
}

/**
 * Import a CSV file into the shared buffer.
 * The buffer can then be used by any app (Discovery, Decoder).
 *
 * @param filePath - Full path to the CSV file
 * @returns Metadata about the imported data
 */
export async function importCsvToBuffer(filePath: string): Promise<BufferMetadata> {
  return invoke("import_csv_to_buffer", { file_path: filePath });
}

// ============================================================================
// Flexible CSV Import API (column mapping)
// ============================================================================

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
  | "direction";

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
}

/**
 * Preview a CSV file: reads first N rows, detects headers, suggests column mappings.
 *
 * @param filePath - Full path to the CSV file
 * @param maxRows - Maximum preview rows (default: 20)
 * @returns Preview data with suggested mappings
 */
export async function previewCsv(
  filePath: string,
  maxRows?: number
): Promise<CsvPreview> {
  return invoke("preview_csv", {
    file_path: filePath,
    max_rows: maxRows ?? null,
  });
}

/**
 * Import a CSV file with user-provided column mappings.
 *
 * @param filePath - Full path to the CSV file
 * @param mappings - Column role assignments
 * @param skipFirstRow - Whether to skip the first row (header)
 * @returns Buffer metadata for the imported data
 */
export async function importCsvWithMapping(
  filePath: string,
  mappings: CsvColumnMapping[],
  skipFirstRow: boolean,
  timestampUnit: TimestampUnit,
  negateTimestamps: boolean
): Promise<BufferMetadata> {
  return invoke("import_csv_with_mapping", {
    file_path: filePath,
    mappings,
    skip_first_row: skipFirstRow,
    timestamp_unit: timestampUnit,
    negate_timestamps: negateTimestamps,
  });
}

/**
 * Get the current buffer metadata.
 * Returns null if no data is loaded.
 */
export async function getBufferMetadata(): Promise<BufferMetadata | null> {
  return invoke("get_buffer_metadata");
}

/**
 * Clear the shared buffer.
 */
export async function clearBuffer(): Promise<void> {
  return invoke("clear_buffer");
}

/**
 * A single CAN frame from the buffer.
 */
export interface BufferFrame {
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
 * WARNING: For large buffers (>100k frames), use getBufferFramesPaginated instead.
 */
export async function getBufferFrames(): Promise<BufferFrame[]> {
  return invoke("get_buffer_frames");
}

/**
 * Response for paginated buffer frames
 */
export interface PaginatedFramesResponse {
  frames: BufferFrame[];
  total_count: number;
  offset: number;
  limit: number;
  /** 1-based original buffer position (rowid) for each frame, parallel to `frames`. */
  buffer_indices: number[];
}

/**
 * Get a page of frames from the shared buffer.
 * Use this for large datasets to avoid IPC overload.
 *
 * @param offset - Starting index (0-based)
 * @param limit - Maximum number of frames to return
 */
export async function getBufferFramesPaginated(
  offset: number,
  limit: number
): Promise<PaginatedFramesResponse> {
  return invoke("get_buffer_frames_paginated", { offset, limit });
}

/**
 * Get a page of frames from the shared buffer, filtered by selected frame IDs.
 * Use this when the user has selected specific frames in the frame picker.
 *
 * @param offset - Starting index (0-based) in the filtered result
 * @param limit - Maximum number of frames to return
 * @param selectedIds - Array of frame IDs to include (empty = all frames)
 */
export async function getBufferFramesPaginatedFiltered(
  offset: number,
  limit: number,
  selectedIds: number[]
): Promise<PaginatedFramesResponse> {
  return invoke("get_buffer_frames_paginated_filtered", {
    offset,
    limit,
    selected_ids: selectedIds,
  });
}

/**
 * Response for tail buffer frames
 */
export interface TailResponse {
  frames: BufferFrame[];
  /** 1-based original buffer position (rowid) for each frame, parallel to `frames`. */
  buffer_indices: number[];
  total_filtered_count: number;
  buffer_end_time_us: number | null;
}

/**
 * Get the most recent N frames from the active buffer, optionally filtered by frame IDs.
 * Used for "tail mode" during streaming - shows latest frames without frontend accumulation.
 *
 * @param limit - Maximum number of frames to return
 * @param selectedIds - Array of frame IDs to filter by (empty = all frames)
 */
export async function getBufferFramesTail(
  limit: number,
  selectedIds: number[]
): Promise<TailResponse> {
  return invoke("get_buffer_frames_tail", {
    limit,
    selected_ids: selectedIds,
  });
}

/**
 * Get a page of frames from a specific buffer by ID.
 * Use this to fetch frames from a derived buffer (e.g., framing results).
 *
 * @param bufferId - The buffer ID
 * @param offset - Starting index (0-based)
 * @param limit - Maximum number of frames to return
 */
export async function getBufferFramesPaginatedById(
  bufferId: string,
  offset: number,
  limit: number
): Promise<PaginatedFramesResponse> {
  return invoke("get_buffer_frames_paginated_by_id", {
    buffer_id: bufferId,
    offset,
    limit,
  });
}

/**
 * Frame info extracted from the buffer
 */
export interface BufferFrameInfo {
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
export async function getBufferFrameInfo(): Promise<BufferFrameInfo[]> {
  return invoke("get_buffer_frame_info");
}

/**
 * Find the offset in the filtered buffer for a given timestamp.
 * Used for timeline scrubber navigation in buffer mode.
 *
 * @param timestampUs - Target timestamp in microseconds
 * @param selectedIds - Array of frame IDs to filter by (empty = all frames)
 * @returns Offset of the first frame at or after the given timestamp
 */
export async function findBufferOffsetForTimestamp(
  timestampUs: number,
  selectedIds: number[]
): Promise<number> {
  return invoke("find_buffer_offset_for_timestamp", {
    timestamp_us: timestampUs,
    selected_ids: selectedIds,
  });
}

/**
 * Create a reader session for the shared buffer.
 * The buffer must have data loaded (via importCsvToBuffer).
 *
 * @param sessionId - Unique session ID (e.g., "discovery", "decoder")
 * @param speed - Playback speed (0 = no limit, 1 = realtime)
 * @returns Reader capabilities
 */
export async function createBufferReaderSession(
  sessionId: string,
  speed?: number
): Promise<IOCapabilities> {
  return invoke("create_buffer_reader_session", {
    session_id: sessionId,
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
export async function listBuffers(): Promise<BufferMetadata[]> {
  return invoke("list_buffers");
}

/**
 * List only orphaned buffers (no owning session).
 * These are buffers available for standalone selection in the IO picker.
 * Includes CSV imports and buffers from destroyed sessions.
 */
export async function listOrphanedBuffers(): Promise<BufferMetadata[]> {
  return invoke("list_orphaned_buffers");
}

/**
 * Delete a specific buffer by ID.
 *
 * @param bufferId - The buffer ID to delete
 */
export async function deleteBuffer(bufferId: string): Promise<void> {
  return invoke("delete_buffer", { buffer_id: bufferId });
}

/**
 * Get metadata for a specific buffer by ID.
 *
 * @param bufferId - The buffer ID to look up
 * @returns Buffer metadata, or null if not found
 */
export async function getBufferMetadataById(bufferId: string): Promise<BufferMetadata | null> {
  return invoke("get_buffer_metadata_by_id", { buffer_id: bufferId });
}

/**
 * Get frames from a specific frame buffer by ID.
 * Throws if the buffer doesn't exist or is not a frame buffer.
 *
 * @param bufferId - The buffer ID
 * @returns Array of frames
 */
export async function getBufferFramesById(bufferId: string): Promise<BufferFrame[]> {
  return invoke("get_buffer_frames_by_id", { buffer_id: bufferId });
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
 * @param bufferId - The buffer ID
 * @returns Array of timestamped bytes
 */
export async function getBufferBytesById(bufferId: string): Promise<TimestampedByte[]> {
  return invoke("get_buffer_bytes_by_id", { buffer_id: bufferId });
}

/**
 * Set a specific buffer as active (for legacy single-buffer compatibility).
 * The active buffer is used by functions like getBufferFrames() and getBufferMetadata().
 *
 * @param bufferId - The buffer ID to set as active
 */
export async function setActiveBuffer(bufferId: string): Promise<void> {
  return invoke("set_active_buffer", { buffer_id: bufferId });
}

/**
 * Create a new frame buffer from frames passed from the frontend.
 * Used when accepting client-side framing to persist the framed data.
 *
 * @param name - Display name for the buffer
 * @param frames - Array of frames to store
 * @returns Metadata of the created buffer
 */
export async function createFrameBufferFromFrames(
  name: string,
  frames: BufferFrame[]
): Promise<BufferMetadata> {
  return invoke("create_frame_buffer_from_frames", { name, frames });
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
export async function getBufferBytesPaginated(
  offset: number,
  limit: number
): Promise<PaginatedBytesResponse> {
  return invoke("get_buffer_bytes_paginated", { offset, limit });
}

/**
 * Get the total byte count from the active buffer.
 */
export async function getBufferBytesCount(): Promise<number> {
  return invoke("get_buffer_bytes_count");
}

/**
 * Get a page of bytes from a specific buffer by ID.
 *
 * @param bufferId - The buffer ID
 * @param offset - Starting index (0-based)
 * @param limit - Maximum number of bytes to return
 */
export async function getBufferBytesPaginatedById(
  bufferId: string,
  offset: number,
  limit: number
): Promise<PaginatedBytesResponse> {
  return invoke("get_buffer_bytes_paginated_by_id", { buffer_id: bufferId, offset, limit });
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
  /** ID of the new frame buffer */
  buffer_id: string;
  /** Number of frames excluded by min_length filter */
  filtered_count: number;
  /** ID of the filtered frames buffer (frames that were too short) */
  filtered_buffer_id: string | null;
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
export async function applyFramingToBuffer(
  config: BackendFramingConfig,
  reuseBufferId?: string | null
): Promise<FramingResult> {
  return invoke("apply_framing_to_buffer", {
    config,
    reuse_buffer_id: reuseBufferId ?? null,
  });
}

/**
 * Find the byte offset at or after the given timestamp in the active byte buffer.
 * Uses binary search for O(log n) performance.
 *
 * @param targetTimeUs - Target timestamp in microseconds
 * @returns Offset of the first byte at or after the given timestamp
 */
export async function findBufferBytesOffsetForTimestamp(
  targetTimeUs: number
): Promise<number> {
  return invoke("find_buffer_bytes_offset_for_timestamp", { target_time_us: targetTimeUs });
}
