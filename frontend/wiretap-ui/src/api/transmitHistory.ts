// ui/src/api/transmitHistory.ts
//
// Tauri API wrappers for the SQLite-backed transmit history.

import { invoke } from "@tauri-apps/api/core";

export interface TransmitHistoryRow {
  id: number;
  session_id: string;
  timestamp_us: number;
  kind: "can" | "serial";
  frame_id: number | null;
  dlc: number | null;
  bytes: number[];
  bus: number;
  is_extended: boolean;
  is_fd: boolean;
  success: boolean;
  error_msg: string | null;
}

export async function transmitHistoryQuery(
  sessionId: string,
  offset: number,
  limit: number
): Promise<TransmitHistoryRow[]> {
  return invoke("transmit_history_query", { sessionId, offset, limit });
}

export async function transmitHistoryCount(sessionId: string): Promise<number> {
  return invoke("transmit_history_count", { sessionId });
}

/** Clears the session's history and resolves to the history revision it signalled. */
export async function transmitHistoryClear(sessionId: string): Promise<number> {
  return invoke("transmit_history_clear", { sessionId });
}

export async function transmitHistoryTimeRange(sessionId: string): Promise<[number, number] | null> {
  return invoke("transmit_history_time_range", { sessionId });
}

export async function transmitHistoryFindOffset(sessionId: string, timestampUs: number): Promise<number> {
  return invoke("transmit_history_find_offset", { sessionId, timestampUs });
}
