// Generated from the Rust serde types by `npm run gen:types`. Do not edit.
import type { BusMapping } from "./BusMapping";
import type { CaptureKind } from "./CaptureKind";
import type { IOCapabilities } from "./IOCapabilities";
import type { IOState } from "./IOState";
import type { SessionMode } from "./SessionMode";
import type { SessionSourceKind } from "./SessionSourceKind";

/**
 * The session an open joined or created, and how the start it made went.
 */
export type OpenedSession = { session_id: string, created: boolean, 
/**
 * Why the start this open made failed. The session stays, in its error state.
 */
start_error: string | null, 
/**
 * The buses each source was given, when `sources` opened the session.
 */
bus_mappings: { [key in string]: Array<BusMapping> } | null, 
/**
 * Session capabilities
 */
capabilities: IOCapabilities, 
/**
 * Current session state
 */
state: IOState, 
/**
 * Active capture ID (if any)
 */
capture_id: string | null, 
/**
 * Capture kind
 */
capture_kind: CaptureKind | null, 
/**
 * Total number of subscribers
 */
subscriber_count: number, 
/**
 * Error that occurred before this subscriber registered (one-shot, cleared after return)
 */
startup_error: string | null, 
/**
 * Profiles the session was opened from (see `get_session_origin_profile_ids`)
 */
origin_profile_ids: Array<string>, 
/**
 * What kind of source is behind the session, as the roster reports it
 */
source_type: string, source_kind: SessionSourceKind, mode: SessionMode, };
