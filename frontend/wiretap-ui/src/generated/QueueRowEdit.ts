// Generated from the Rust serde types by `npm run gen:types`. Do not edit.
import type { QueueRowSession } from "./QueueRowSession";

/**
 * The fields to change; a blank `group` clears it.
 */
export type QueueRowEdit = { interval_ms?: number | null, enabled?: boolean | null, bus?: number | null, group?: string | null, session?: QueueRowSession | null, };
