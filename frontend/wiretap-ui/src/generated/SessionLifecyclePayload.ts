// Generated from the Rust serde types by `npm run gen:types`. Do not edit.
import type { IOState } from "./IOState";
import type { LifecycleEvent } from "./LifecycleEvent";

/**
 * Payload for global session lifecycle events (emitted to all windows)
 */
export type SessionLifecyclePayload = { 
/**
 * The session ID
 */
session_id: string, event_type: LifecycleEvent, 
/**
 * Device type (e.g., "gvret_tcp", "realtime") - only for "created"
 */
source_type: string | null, 
/**
 * Current state - only for "created"
 */
state: IOState | null, 
/**
 * Number of listeners
 */
subscriber_count: number, 
/**
 * Source profile IDs
 */
source_profile_ids: Array<string>, 
/**
 * The subscriber ID that created the session (only for "created")
 */
creator_subscriber_id: string | null, 
/**
 * True when a "destroyed" event was a deliberate user destroy (the app should
 * reset to "No source" rather than fall back to the orphaned capture).
 */
reset: boolean, };
