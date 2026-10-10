// Generated from the Rust serde types by `npm run gen:types`. Do not edit.
import type { QueueOrigin } from "./QueueOrigin";
import type { QueuePayload } from "./QueuePayload";

export type QueueRow = { id: string, payload: QueuePayload, interval_ms: number, enabled: boolean, group: string | null, origin: QueueOrigin, 
/**
 * Sending now, on its own or in its running group.
 */
repeating: boolean, 
/**
 * Why its last repeat stopped by itself.
 */
last_error: string | null, session_id: string, profile_id: string, profile_name: string, };
