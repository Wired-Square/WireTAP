// ui/src/api/dashboards.ts
// Dashboard artifact (*.dashboard.json) Tauri commands.

import { invoke } from "@tauri-apps/api/core";

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
