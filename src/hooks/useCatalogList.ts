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
// source of truth. The initial fetch on mount means no startup race where the
// picker shows empty; re-syncing on reconnect catches changes missed while the
// socket was down. Mirrors useOpenAppsSync.

import { useEffect, useState } from "react";
import { listCatalogs, type CatalogMetadata } from "../api/catalog";
import { wsTransport } from "../services/wsTransport";
import { MsgType } from "../services/wsProtocol";

export function useCatalogList(): CatalogMetadata[] {
  const [catalogs, setCatalogs] = useState<CatalogMetadata[]>([]);

  useEffect(() => {
    let cancelled = false;
    const reconcile = () => {
      listCatalogs()
        .then((list) => {
          if (!cancelled) setCatalogs(list);
        })
        .catch((e) => console.error("Failed to load catalog list:", e));
    };

    reconcile(); // initial sync — populates before the first push
    const unlistenChanged = wsTransport.onGlobalMessage(
      MsgType.CatalogListChanged,
      reconcile
    );
    const unlistenReconnect = wsTransport.onReconnect(reconcile);

    return () => {
      cancelled = true;
      unlistenChanged();
      unlistenReconnect();
    };
  }, []);

  return catalogs;
}
