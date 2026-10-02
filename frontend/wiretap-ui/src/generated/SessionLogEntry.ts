// Generated from the Rust serde types by `npm run gen:types`. Do not edit.
import type { SessionLogEvent } from "./SessionLogEvent";

export type SessionLogEntry = { 
/**
 * Increases by one per entry for the life of the process; read the ring after it to catch up.
 */
id: number, timestamp_ms: number, session_id: string | null, profile_ids: Array<string>, subscriber_id: string | null, app_name: string | null, event: SessionLogEvent, };
