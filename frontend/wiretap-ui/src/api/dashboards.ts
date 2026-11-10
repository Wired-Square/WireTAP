// ui/src/api/dashboards.ts
// Dashboard artifact (*.dashboard.json) Tauri commands.

import { invoke } from "@tauri-apps/api/core";
import type { SignalValueFormat } from "../generated/SignalValueFormat";
import type { Signal } from "../types/catalogModel";

export interface DashboardFile {
  name: string;
  filename: string;
  path: string;
}

/** List dashboard files in the dashboards dir (a subdir of the decoder dir). */
export async function listDashboards(): Promise<DashboardFile[]> {
  return await invoke<DashboardFile[]>("list_dashboards");
}

/** Read a dashboard file's JSON content by absolute path. */
export async function openDashboard(path: string): Promise<string> {
  return await invoke<string>("open_dashboard", { path });
}

/** Save a dashboard by filename into the dashboards dir. Returns the full path. */
export async function saveDashboard(filename: string, content: string): Promise<string> {
  return await invoke<string>("save_dashboard", { filename, content });
}

/** How each signal's computed values (a min, a mean, a cursor reading) read, in order. */
export async function signalValueFormats(signals: Signal[]): Promise<SignalValueFormat[]> {
  return await invoke<SignalValueFormat[]>("signal_value_formats", { signals });
}
