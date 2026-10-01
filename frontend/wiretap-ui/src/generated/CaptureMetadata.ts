// Generated from the Rust serde types by `npm run gen:types`. Do not edit.
import type { CaptureKind } from "./CaptureKind";

/**
 * Metadata about a capture
 */
export type CaptureMetadata = { 
/**
 * Unique capture ID (e.g., "xk9m2p", "r7f3kw")
 */
id: string, 
/**
 * Capture kind (frames or bytes)
 */
kind: CaptureKind, 
/**
 * Display name (e.g., "GVRET 10:30am", "Serial dump")
 */
name: string, 
/**
 * Number of items (frames or bytes depending on type)
 */
count: number, 
/**
 * Timestamp of first item (microseconds)
 */
start_time_us: number | null, 
/**
 * Timestamp of last item (microseconds)
 */
end_time_us: number | null, 
/**
 * When the capture was created (Unix timestamp in seconds)
 */
created_at: number, 
/**
 * Whether this capture is actively receiving data (is the streaming target)
 */
is_streaming: boolean, 
/**
 * Session ID that owns this capture (None = orphaned, available for standalone use)
 * Captures with an owning session are only accessible through that session.
 * When a session is destroyed, the capture is orphaned (owning_session_id = None).
 */
owning_session_id: string | null, 
/**
 * Whether this capture survives app restart when 'clear captures on start' is enabled.
 */
persistent: boolean, 
/**
 * Distinct bus numbers seen in this capture's data (sorted).
 * Enables bus mapping/wiring when a capture is used as a source.
 */
buses: Array<number>, };
