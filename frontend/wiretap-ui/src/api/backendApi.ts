// ui/src/api/backendApi.ts
//
// Wrappers for the WireTAP backend gateway commands (wiretap profiles).
// These talk to the Rust apiclient module, which in turn calls the backend
// HTTP API. Used by the profile editor and the "Send to backend" capture
// upload flow.

import { invoke } from "@tauri-apps/api/core";
import type { ArchiveProtocol } from "../settings/appSettings";
import type { AssignmentOutcome } from "../generated/AssignmentOutcome";
import type { GatewayDaemon } from "../generated/GatewayDaemon";
import type { CatalogueRef } from "../generated/CatalogueRef";

export interface ApiDatabase {
  name: string;
  size_bytes: number;
}

/** What `/v1/health` and `/v1/databases` say about a gateway. */
export interface BackendProbe {
  /** e.g. "0.1.0 (gc21b57813120)" — names the build you are talking to. */
  version: string;
  status: string;
  db_ok: boolean;
  databases: ApiDatabase[];
  /** Why the database list is empty when it is — usually the key was refused. */
  databases_error: string | null;
}

/** The key is what was typed, else the saved profile's; both may be absent. */
export interface EditorCredentials {
  url: string;
  apiKey?: string;
  profileId?: string | null;
}

/**
 * Probe a gateway from loose parameters, so an unsaved profile works. Health
 * needs no key, so a wrong key still reports the version.
 */
export async function apiProbeBackend(creds: EditorCredentials): Promise<BackendProbe> {
  return invoke<BackendProbe>("api_probe_backend", {
    url: creds.url,
    apiKey: creds.apiKey || null,
    profileId: creds.profileId || null,
  });
}

/** The protocols a capture database holds, for defaulting a profile's. */
export async function apiDatabaseProtocols(
  creds: EditorCredentials,
  database: string,
): Promise<ArchiveProtocol[]> {
  return invoke<ArchiveProtocol[]>("api_database_protocols", {
    url: creds.url,
    apiKey: creds.apiKey || null,
    profileId: creds.profileId || null,
    database,
  });
}

/** List capture databases available on a backend (for the profile picker). */
export async function apiListDatabases(profileId: string): Promise<ApiDatabase[]> {
  return invoke<ApiDatabase[]>("api_list_databases", { profileId });
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

/** Each daemon's devices, with what is assigned against what each is running. */
export async function gatewayListDaemons(profileId: string): Promise<GatewayDaemon[]> {
  return invoke<GatewayDaemon[]>("gateway_list_daemons", { profileId });
}

/** `expected` is the SHA shown as assigned, `""` for none; the gateway answers a conflict if it moved. */
export async function gatewayAssignCatalogue(
  profileId: string,
  daemonId: string,
  iface: string,
  filename: string,
  expected: string,
): Promise<AssignmentOutcome> {
  return invoke<AssignmentOutcome>("gateway_assign_catalogue", {
    profileId,
    daemonId,
    interface: iface,
    filename,
    expected,
  });
}

export async function gatewayClearAssignment(
  profileId: string,
  daemonId: string,
  iface: string,
  expected: string,
): Promise<AssignmentOutcome> {
  return invoke<AssignmentOutcome>("gateway_clear_assignment", { profileId, daemonId, interface: iface, expected });
}

/** Copy a catalogue the gateway stores into the decoder library, returning its path. */
export async function gatewayCopyCatalogue(profileId: string, catalogue: CatalogueRef): Promise<string> {
  return invoke<string>("gateway_copy_catalogue", { profileId, blobSha: catalogue.blobSha, name: catalogue.name });
}

export interface CaptureUploadProgress {
  capture_id: string;
  sent: number;
  total: number;
  done: boolean;
}
