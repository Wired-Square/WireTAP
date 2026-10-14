// Generated from the Rust serde types by `npm run gen:types`. Do not edit.

export type DatabaseActivity = { pid: number, database: string | null, username: string | null, application_name: string | null, client_addr: string | null, state: string | null, query: string | null, 
/**
 * PostgreSQL's `timestamptz::text`, not RFC 3339.
 */
query_start: string | null, duration_secs: number | null, is_cancellable: boolean, };
