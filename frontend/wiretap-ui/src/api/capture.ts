// ui/src/api/capture.ts
//
// API wrappers for the multi-capture registry system.
// Supports multiple named captures with typed storage (frames or bytes).

import { invoke } from "@tauri-apps/api/core";
import type { IOCapabilities } from "./io";
import type { ProtocolFrames } from "../utils/frameKey";
import type { Protocol } from "../utils/profileTraits";
import type { FrameMessage } from "../types/frame";

import type { BackendFramingConfig } from "../generated/BackendFramingConfig";
import type { CandumpImportResult } from "../generated/CandumpImportResult";
import type { CaptureFrameInfo } from "../generated/CaptureFrameInfo";
import type { CaptureKind } from "../generated/CaptureKind";
import type { CaptureMetadata } from "../generated/CaptureMetadata";
import type { CsvColumnMapping } from "../generated/CsvColumnMapping";
import type { CsvColumnRole } from "../generated/CsvColumnRole";
import type { CsvImportResult } from "../generated/CsvImportResult";
import type { CsvPreview } from "../generated/CsvPreview";
import type { Delimiter } from "../generated/Delimiter";
import type { FrameIdConfig } from "../generated/FrameIdConfig";
import type { FramingResult } from "../generated/FramingResult";
import type { InterfaceFramingConfig } from "../generated/InterfaceFramingConfig";
import type { ModbusRtuOptions } from "../generated/ModbusRtuOptions";
import type { PaginatedBytesResponse } from "../generated/PaginatedBytesResponse";
import type { PaginatedFramesResponse } from "../generated/PaginatedFramesResponse";
import type { SequenceGap } from "../generated/SequenceGap";
import type { SerialIds } from "../generated/SerialIds";
import type { SkippedLine } from "../generated/SkippedLine";
import type { TailResponse } from "../generated/TailResponse";
import type { TimestampedByte } from "../generated/TimestampedByte";
import type { TimestampUnit } from "../generated/TimestampUnit";
import type { FrameMessage as CaptureFrame } from "../generated/FrameMessage";

export type {
  BackendFramingConfig,
  CandumpImportResult,
  CaptureFrame,
  CaptureFrameInfo,
  CaptureKind,
  CaptureMetadata,
  CsvColumnMapping,
  CsvColumnRole,
  CsvImportResult,
  CsvPreview,
  Delimiter,
  FrameIdConfig,
  FramingResult,
  InterfaceFramingConfig,
  ModbusRtuOptions,
  PaginatedBytesResponse,
  PaginatedFramesResponse,
  SequenceGap,
  SerialIds,
  SkippedLine,
  TailResponse,
  TimestampedByte,
  TimestampUnit,
};

/** Whether every file is a candump log, which skips the column mapper. */
export async function detectCandump(filePaths: string[]): Promise<boolean> {
  return invoke("detect_candump", { file_paths: filePaths });
}

/** Import candump logs into one capture, merged in time order with their absolute times. */
export async function importCandump(sessionId: string, filePaths: string[]): Promise<CandumpImportResult> {
  return invoke("import_candump", { session_id: sessionId, file_paths: filePaths });
}

// ============================================================================
// Flexible CSV Import API (column mapping)
// ============================================================================

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
 * @param protocol - The protocol every imported frame carries
 * @returns Capture metadata for the imported data
 */
export async function importCsvWithMapping(
  sessionId: string,
  filePath: string,
  mappings: CsvColumnMapping[],
  skipFirstRow: boolean,
  timestampUnit: TimestampUnit,
  negateTimestamps: boolean,
  delimiter: Delimiter,
  protocol: Protocol
): Promise<CsvImportResult> {
  return invoke("import_csv_with_mapping", {
    session_id: sessionId,
    file_path: filePath,
    mappings,
    skip_first_row: skipFirstRow,
    timestamp_unit: timestampUnit,
    negate_timestamps: negateTimestamps,
    delimiter,
    protocol,
  });
}

/**
 * Import multiple data files with shared column mappings into a single capture.
 * Files are parsed sequentially and concatenated in order.
 *
 * @param filePaths - Ordered list of file paths to import
 * @param mappings - Column role assignments (applied to all files)
 * @param skipFirstRowPerFile - Per-file flag: whether to skip the first row (header)
 * @param timestampUnit - Timestamp unit for all files
 * @param negateTimestamps - Whether to negate timestamps
 * @param delimiter - Column delimiter
 * @param protocol - The protocol every imported frame carries
 * @returns Capture metadata for the merged data
 */
export async function importCsvBatchWithMapping(
  sessionId: string,
  filePaths: string[],
  mappings: CsvColumnMapping[],
  skipFirstRowPerFile: boolean[],
  timestampUnit: TimestampUnit,
  negateTimestamps: boolean,
  delimiter: Delimiter,
  protocol: Protocol
): Promise<CsvImportResult> {
  return invoke("import_csv_batch_with_mapping", {
    session_id: sessionId,
    file_paths: filePaths,
    mappings,
    skip_first_row_per_file: skipFirstRowPerFile,
    timestamp_unit: timestampUnit,
    negate_timestamps: negateTimestamps,
    delimiter,
    protocol,
  });
}

/**
 * Get metadata for a specific capture.
 * Returns null if the capture doesn't exist.
 *
 * @param captureId - The capture ID to look up
 */
export async function getCaptureMetadata(captureId: string): Promise<CaptureMetadata | null> {
  return invoke("get_capture_metadata", { capture_id: captureId });
}

/**
 * Get all frames from the shared capture.
 * Returns an empty array if no data is loaded.
 * WARNING: For large buffers (>100k frames), use getCaptureFramesPaginated instead.
 */
export async function getCaptureFrames(captureId: string): Promise<CaptureFrame[]> {
  return invoke("get_capture_frames", { capture_id: captureId });
}

/**
 * Get a page of frames from the shared capture.
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
 * Get a page of frames from the shared capture, filtered by selected frames.
 * Use this when the user has selected specific frames in the frame picker.
 *
 * @param offset - Starting index (0-based) in the filtered result
 * @param limit - Maximum number of frames to return
 * @param selection - Frames to include, grouped by protocol (empty = all frames)
 */
export async function getCaptureFramesPaginatedFiltered(
  captureId: string,
  offset: number,
  limit: number,
  selection: ProtocolFrames[]
): Promise<PaginatedFramesResponse> {
  return invoke("get_capture_frames_paginated_filtered", {
    capture_id: captureId,
    offset,
    limit,
    selection,
  });
}

/**
 * Get the most recent N frames from the active capture, optionally filtered by selected frames.
 * Used for "tail mode" during streaming - shows latest frames without frontend accumulation.
 *
 * @param limit - Maximum number of frames to return
 * @param selection - Frames to include, grouped by protocol (empty = all frames)
 */
export async function getCaptureFramesTail(
  captureId: string,
  limit: number,
  selection: ProtocolFrames[]
): Promise<TailResponse> {
  return invoke("get_capture_frames_tail", {
    capture_id: captureId,
    limit,
    selection,
  });
}

/**
 * Get a page of frames from a specific capture by ID.
 * Use this to fetch frames from a derived capture (e.g., framing results).
 *
 * @param captureId - The capture ID
 * @param offset - Starting index (0-based)
 * @param limit - Maximum number of frames to return
 */
/** Rows per page when walking a whole capture. Large enough that most captures are one trip. */
export const CAPTURE_PAGE_SIZE = 50000;

/**
 * The newest frame per identity in a capture — one row per (protocol, frame_id).
 *
 * For anything that wants "the current value of each thing" rather than the
 * history, this is the read to use: a Modbus sweep with 20 passes writes 20 rows
 * per register, and reading them all to keep the last of each ships 20× the data
 * for the same answer.
 */
export async function getCaptureLatestFrames(captureId: string): Promise<CaptureFrame[]> {
  return invoke("get_capture_latest_frames", { capture_id: captureId });
}

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

export type FrameDumpSource = { captureId: string } | { frames: FrameMessage[] };

/** Write a CSV or candump export in Rust; it refuses the whole file if any frame cannot be written. */
export async function exportFrameDump(
  source: FrameDumpSource,
  format: "csv" | "candump",
  path: string,
): Promise<number> {
  const wire = "captureId" in source ? { capture_id: source.captureId } : source;
  return invoke("export_frame_dump", { source: wire, format, path });
}

/**
 * Get unique frame IDs and their metadata from the capture.
 * Used to build the frame picker after a large ingest.
 */
export async function getCaptureFrameInfo(captureId: string): Promise<CaptureFrameInfo[]> {
  return invoke("get_capture_frame_info", { capture_id: captureId });
}

/**
 * Find the offset in the filtered capture for a given timestamp.
 * Used for timeline scrubber navigation in capture mode.
 *
 * @param timestampUs - Target timestamp in microseconds
 * @param selection - Frames to include, grouped by protocol (empty = all frames)
 * @returns Offset of the first frame at or after the given timestamp
 */
export async function findCaptureOffsetForTimestamp(
  captureId: string,
  timestampUs: number,
  selection: ProtocolFrames[]
): Promise<number> {
  return invoke("find_capture_offset_for_timestamp", {
    capture_id: captureId,
    timestamp_us: timestampUs,
    selection,
  });
}

/**
 * Create a reader session for the shared capture.
 * The capture must have data loaded.
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
// Multi-Capture Registry API
// ============================================================================

/**
 * List all buffers in the registry.
 * Returns metadata for all buffers (frame and byte types).
 */
export async function listCaptures(): Promise<CaptureMetadata[]> {
  return invoke("list_captures");
}

/**
 * List all known capture IDs (lightweight — no metadata).
 * Used to populate the known capture ID set for `isCaptureProfileId()` lookups.
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
 * Delete a specific capture by ID.
 *
 * @param captureId - The capture ID to delete
 */
export async function deleteCapture(captureId: string): Promise<void> {
  await invoke("delete_capture", { capture_id: captureId });
  // Remove from known capture ID cache
  const { useSessionStore } = await import("../stores/sessionStore");
  useSessionStore.getState().removeKnownCaptureId(captureId);
}

/**
 * Clear a capture's data without deleting the capture itself.
 * The session keeps its reference and can continue writing new frames.
 *
 * @param captureId - The capture ID to clear
 */
export async function clearCaptureData(captureId: string): Promise<void> {
  return invoke("clear_capture", { capture_id: captureId });
}

/**
 * Rename a capture.
 *
 * @param captureId - The capture ID to rename
 * @param newName - The new display name
 * @returns Updated capture metadata
 */
export async function renameCapture(captureId: string, newName: string): Promise<CaptureMetadata> {
  return invoke("rename_capture", { capture_id: captureId, new_name: newName });
}

/**
 * Set a capture's persistent (pinned) flag.
 * Persistent buffers survive app restart when 'clear buffers on start' is enabled.
 *
 * @param captureId - The capture ID
 * @param persistent - Whether the capture should be persistent
 * @returns Updated capture metadata
 */
export async function setCapturePersistent(captureId: string, persistent: boolean): Promise<CaptureMetadata> {
  return invoke("set_capture_persistent", { capture_id: captureId, persistent });
}

/**
 * Get metadata for a specific capture by ID.
 *
 * @param captureId - The capture ID to look up
 * @returns Capture metadata, or null if not found
 */
export async function getCaptureMetadataById(captureId: string): Promise<CaptureMetadata | null> {
  return invoke("get_capture_metadata_by_id", { capture_id: captureId });
}

/**
 * Get frames from a specific frame capture by ID.
 * Throws if the capture doesn't exist or is not a frame capture.
 *
 * @param captureId - The capture ID
 * @returns Array of frames
 */
export async function getCaptureFramesById(captureId: string): Promise<CaptureFrame[]> {
  return invoke("get_capture_frames_by_id", { capture_id: captureId });
}

/**
 * Get raw bytes from a specific byte capture by ID.
 * Throws if the capture doesn't exist or is not a byte capture.
 *
 * @param captureId - The capture ID
 * @returns Array of timestamped bytes
 */
export async function getCaptureBytesById(captureId: string): Promise<TimestampedByte[]> {
  return invoke("get_capture_bytes_by_id", { capture_id: captureId });
}

/**
 * Set a specific capture as active (for legacy single-capture compatibility).
 * The active capture is used by functions like getCaptureFrames() and getCaptureMetadata().
 *
 * @param captureId - The capture ID to set as active
 */
export async function setActiveCapture(captureId: string): Promise<void> {
  return invoke("set_active_capture", { capture_id: captureId });
}

/**
 * Create a new frame capture from frames passed from the frontend.
 * Used when accepting client-side framing to persist the framed data.
 *
 * @param name - Display name for the capture
 * @param frames - Array of frames to store
 * @returns Metadata of the created capture
 */
export async function createFrameCaptureFromFrames(
  sessionId: string,
  name: string,
  frames: FrameMessage[]
): Promise<CaptureMetadata> {
  return invoke("create_frame_capture_from_frames", { session_id: sessionId, name, frames });
}

// ============================================================================
// Byte Capture API (Serial Discovery)
// ============================================================================

/**
 * Get a page of bytes from the active capture.
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
 * Get the total byte count from the active capture.
 */
export async function getCaptureBytesCount(captureId: string): Promise<number> {
  return invoke("get_capture_bytes_count", { capture_id: captureId });
}

/**
 * Get a page of bytes from a specific capture by ID.
 *
 * @param captureId - The capture ID
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
 * Apply framing to the active byte capture.
 * If reuseCaptureId is provided and valid, that capture is cleared and reused.
 * Otherwise, a new frame capture is created.
 * This avoids capture proliferation during live framing.
 *
 * @param config - Framing configuration
 * @param reuseCaptureId - Optional ID of existing framing capture to reuse (avoids proliferation)
 * @param reuseFilteredCaptureId - Same, for the too-short frames the min-length
 *   filter sets aside. Pass it or each re-frame leaves the previous one behind.
 * @returns Result with frame count and capture ID (same as reuseCaptureId if reused, or new ID)
 */
export async function applyFramingToCapture(
  sessionId: string,
  config: BackendFramingConfig,
  reuseCaptureId?: string | null,
  reuseFilteredCaptureId?: string | null
): Promise<FramingResult> {
  return invoke("apply_framing_to_capture", {
    session_id: sessionId,
    config,
    reuse_capture_id: reuseCaptureId ?? null,
    reuse_filtered_capture_id: reuseFilteredCaptureId ?? null,
  });
}

export function toFrameIdConfig(
  config: { startByte: number; numBytes: number; endianness: "big" | "little" } | null,
): FrameIdConfig | undefined {
  return config
    ? { start_byte: config.startByte, num_bytes: config.numBytes, big_endian: config.endianness === "big" }
    : undefined;
}

/** The ids each frame carries under these configs, as the serial reader extracts them. */
export async function extractSerialIds(
  frames: number[][],
  frameIdConfig?: FrameIdConfig,
  sourceAddressConfig?: FrameIdConfig,
): Promise<SerialIds[]> {
  return invoke("extract_serial_ids", {
    frames,
    frame_id_config: frameIdConfig ?? null,
    source_address_config: sourceAddressConfig ?? null,
  });
}

/**
 * Find the byte offset at or after the given timestamp in the active byte capture.
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
 * Search a frame capture for frames matching a query string.
 * Returns 0-based offsets in the filtered result set.
 *
 * @param captureId - The capture ID to search
 * @param query - Search string (whitespace already stripped by caller)
 * @param searchId - Whether to search the frame ID column
 * @param searchData - Whether to search the payload (data) column
 * @param selection - Frames to include, grouped by protocol (empty = all frames)
 */
export async function searchCaptureFrames(
  captureId: string,
  query: string,
  searchId: boolean,
  searchData: boolean,
  selection: ProtocolFrames[]
): Promise<number[]> {
  return invoke("search_capture_frames", {
    capture_id: captureId,
    query,
    search_id: searchId,
    search_data: searchData,
    selection,
  });
}
