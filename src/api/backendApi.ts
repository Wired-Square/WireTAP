// ui/src/api/backendApi.ts
//
// Wrappers for the WireTAP backend gateway commands (wiretap profiles).
// These talk to the Rust apiclient module, which in turn calls the backend
// HTTP API. Used by the profile editor and the "Send to backend" capture
// upload flow.

import { invoke } from "@tauri-apps/api/core";

export interface ApiDatabase {
  name: string;
  size_bytes: number;
}

/** List capture databases available on a backend (for the profile picker). */
export async function apiListDatabases(profileId: string): Promise<ApiDatabase[]> {
  return invoke<ApiDatabase[]>("api_list_databases", { profileId });
}

/** Create a new capture database on the backend (admin key required). */
export async function apiCreateDatabase(profileId: string, name: string): Promise<void> {
  await invoke("api_create_database", { profileId, name });
}

/** Probe backend connectivity ("Test connection"). */
export async function apiTestConnection(profileId: string): Promise<boolean> {
  return invoke<boolean>("api_test_connection", { profileId });
}

/**
 * Upload a local SQLite capture's frames to a backend capture database.
 * Returns the number of frames imported. Progress is emitted via the
 * `capture-upload-progress` event.
 */
export async function apiImportCapture(
  profileId: string,
  captureId: string,
  database: string,
  create: boolean,
): Promise<number> {
  return invoke<number>("api_import_capture", { profileId, captureId, database, create });
}

export interface CaptureUploadProgress {
  capture_id: string;
  sent: number;
  total: number;
  done: boolean;
}
