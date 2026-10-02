// Generated from the Rust serde types by `npm run gen:types`. Do not edit.

/**
 * What a new session is for: the one thing its id's prefix says.
 */
export type SessionPurpose = { "purpose": "sources", profile_ids: Array<string>, emit_raw_bytes?: boolean, } | { "purpose": "ingest" } | { "purpose": "modbus_scan" };
