// Generated from the Rust serde types by `npm run gen:types`. Do not edit.
import type { CaptureKind } from "./CaptureKind";
import type { IOCapabilities } from "./IOCapabilities";
import type { IOState } from "./IOState";
import type { SessionSourceKind } from "./SessionSourceKind";
import type { SourceConfig } from "./SourceConfig";
import type { SubscriberInfo } from "./SubscriberInfo";

/**
 * Info about an active session (for listing)
 */
export type ActiveSessionInfo = { 
/**
 * Session ID
 */
session_id: string, 
/**
 * Device type (e.g., "gvret_tcp", "realtime")
 */
source_type: string, 
/**
 * Current state
 */
state: IOState, 
/**
 * Session capabilities
 */
capabilities: IOCapabilities, 
/**
 * Number of subscribers
 */
subscriber_count: number, 
/**
 * Individual subscriber details
 */
subscribers: Array<SubscriberInfo>, 
/**
 * For multi-source sessions: the source configurations
 */
broker_configs: Array<SourceConfig> | null, 
/**
 * Profile IDs feeding this session (from the session profile registry)
 */
source_profile_ids: Array<string>, 
/**
 * Profiles the session was opened from; differs from `source_profile_ids`
 * only while a stopped source is replaying its capture
 */
origin_profile_ids: Array<string>, source_kind: SessionSourceKind, 
/**
 * Capture ID owned by this session (if any)
 */
capture_id: string | null, 
/**
 * Kind of the capture named by `capture_id`
 */
capture_kind: CaptureKind | null, 
/**
 * Frame count in the owned capture
 */
capture_frame_count: number | null, 
/**
 * Distinct (bus, frame_id) count in the owned capture (live streaming only)
 */
capture_unique_frame_count: number | null, 
/**
 * Whether the session is actively streaming data
 */
is_streaming: boolean, 
/**
 * Source file path of the catalogue attached for live decode (None when no
 * decoder is bound). Authoritative — the frontend mirrors this one-way.
 */
catalog_path: string | null, 
/**
 * Profile IDs within this session whose polling is paused. Authoritative,
 * like `catalog_path`: the poll switch reads it rather than remembering
 * what it last asked for.
 */
paused_source_profile_ids: Array<string>, };
