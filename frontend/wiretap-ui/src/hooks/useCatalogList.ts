// Shared hook: the live list of decoder catalogues from the decoder directory.
//
// The backend owns this list — it builds it once at startup, serves it from a
// warm cache, and keeps it fresh with a filesystem watcher plus the catalogue
// mutation commands. Whenever it changes it pushes a global `CatalogListChanged`
// message over the binary WebSocket transport (not a Tauri event — pushes go
// through the WS, same as frames/session events).
//
// We treat that push as a re-sync signal and reconcile from `list_catalogs`
// (served from the warm cache, so effectively instant), keeping Rust the single
// source of truth. The when-to-resync rule lives in `useWsResync` so every
// derived view reconciles on the same triggers. Mirrors useOpenAppsSync.

import { useState } from "react";
import { listCatalogs, type CatalogMetadata } from "../api/catalog";
import { useWsResync } from "./useWsResync";
import { MsgType } from "../services/wsProtocol";

export function useCatalogList(): CatalogMetadata[] {
  const [catalogs, setCatalogs] = useState<CatalogMetadata[]>([]);

  // No unmount guard: a setState after unmount is a no-op in React 18, and a
  // ref-based guard is actively wrong under StrictMode's setup→cleanup→setup, which
  // would latch it closed and leave the list permanently empty in dev.
  useWsResync(MsgType.CatalogListChanged, () => {
    listCatalogs()
      .then(setCatalogs)
      .catch((e) => console.error("Failed to load catalog list:", e));
  });

  return catalogs;
}
