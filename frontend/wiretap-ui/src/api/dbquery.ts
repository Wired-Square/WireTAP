// src/api/dbquery.ts
//
// API wrappers for a WireTAP backend's activity (the Query app's Stats tab).

import { invoke } from "@tauri-apps/api/core";

/** A running query or session from pg_stat_activity */
export interface DatabaseActivity {
  /** Process ID (pid) of the backend */
  pid: number;
  /** Database name */
  database: string | null;
  /** Username */
  username: string | null;
  /** Application name (e.g., "WireTAP Query") */
  application_name: string | null;
  /** Client address */
  client_addr: string | null;
  /** Current state (active, idle, idle in transaction, etc.) */
  state: string | null;
  /** Current query text (truncated) */
  query: string | null;
  /** When the query started, as PostgreSQL's `timestamptz::text` (not RFC 3339) */
  query_start: string | null;
  /** How long the query has been running in seconds */
  duration_secs: number | null;
  /** Whether this is a query we can cancel */
  is_cancellable: boolean;
}

/** Result of querying database activity */
export interface DatabaseActivityResult {
  /** Active queries running on the database */
  queries: DatabaseActivity[];
  /** Active sessions connected to the database */
  sessions: DatabaseActivity[];
}

/**
 * Query pg_stat_activity for running queries and active sessions.
 *
 * Returns information about queries currently running on the database
 * and all active sessions (connections).
 */
export async function queryActivity(
  profileId: string
): Promise<DatabaseActivityResult> {
  return invoke("db_query_activity", { profileId });
}

/**
 * Cancel a running query by backend PID using pg_cancel_backend.
 *
 * This sends a SIGINT to the backend process, which will cancel the current query
 * but keep the connection alive.
 *
 * @returns true if the cancel signal was sent successfully
 */
export async function cancelBackend(
  profileId: string,
  pid: number
): Promise<boolean> {
  return invoke("db_cancel_backend", { profileId, pid });
}

/**
 * Terminate a backend session by PID using pg_terminate_backend.
 *
 * This terminates the entire connection, not just the current query.
 * Use with caution.
 *
 * @returns true if the terminate signal was sent successfully
 */
export async function terminateBackend(
  profileId: string,
  pid: number
): Promise<boolean> {
  return invoke("db_terminate_backend", { profileId, pid });
}
