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
  offset: number,
  limit: number
): Promise<TransmitHistoryRow[]> {
  return invoke("transmit_history_query", { offset, limit });
}

export async function transmitHistoryCount(): Promise<number> {
  return invoke("transmit_history_count");
}

export async function transmitHistoryClear(): Promise<void> {
  return invoke("transmit_history_clear");
}
