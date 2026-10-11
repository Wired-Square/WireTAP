// Generated from the Rust serde types by `npm run gen:types`. Do not edit.
import type { CaptureKind } from "./CaptureKind";

/**
 * A capture's `capture_metadata` row.
 */
export type CaptureMetadata = { id: string, kind: CaptureKind, name: string, 
/**
 * Frames or bytes, by `kind`.
 */
count: number, start_time_us: number | null, end_time_us: number | null, 
/**
 * Unix seconds.
 */
created_at: number, 
/**
 * The application's to set; not stored, so it loads as `false`.
 */
is_streaming: boolean, 
/**
 * `None` is orphaned, open to standalone use.
 */
owning_session_id: string | null, 
/**
 * Survives a clear on start.
 */
persistent: boolean, 
/**
 * The distinct buses in the capture's data, sorted.
 */
buses: Array<number>, };
