// Thin fetch wrapper. The admin key lives in sessionStorage for the life of
// the tab; every call sends it as a Bearer token.

const KEY_STORAGE = "wiretap-admin-key";

export function getKey(): string | null {
  return sessionStorage.getItem(KEY_STORAGE);
}

export function setKey(key: string) {
  sessionStorage.setItem(KEY_STORAGE, key);
}

export function clearKey() {
  sessionStorage.removeItem(KEY_STORAGE);
}

export async function api<T>(
  path: string,
  options: { method?: string; body?: unknown } = {},
): Promise<T> {
  const headers: Record<string, string> = {};
  const key = getKey();
  if (key) headers["Authorization"] = `Bearer ${key}`;
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  const resp = await fetch(path, {
    method: options.method ?? "GET",
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
  if (!resp.ok) {
    let message = `${resp.status}`;
    try {
      message = (await resp.json()).error ?? message;
    } catch {
      /* non-JSON error body */
    }
    throw new Error(message);
  }
  return resp.json() as Promise<T>;
}

export interface KeySummary {
  id: number;
  name: string;
  role: "read" | "ingest" | "admin";
  database_pin: string | null;
  created_at: string;
  last_used_at: string | null;
  revoked: boolean;
}

export interface DatabaseEntry {
  name: string;
  size_bytes: number;
}

export interface IngestSession {
  peer: string;
  key_name: string;
  database: string;
  frames: number;
  batches: number;
  queue_pct: number;
  connected_at: string;
}

export interface Activity {
  pid: number;
  username: string | null;
  application_name: string | null;
  client_addr: string | null;
  state: string | null;
  query: string | null;
  duration_secs: number | null;
  is_cancellable: boolean;
}

export function formatBytes(n: number): string {
  if (n >= 1e12) return `${(n / 1e12).toFixed(1)} TB`;
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} MB`;
  return `${(n / 1e3).toFixed(0)} kB`;
}
