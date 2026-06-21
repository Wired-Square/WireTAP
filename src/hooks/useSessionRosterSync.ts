// Copyright 2026 Wired Square Pty Ltd
//
// Window-global session-roster sync. Adopts backend sessions (including
// agent/MCP-created ones) into useSessionStore as known-only entries by
// reconciling against listActiveSessions() on each global SessionLifecycle
// broadcast. Global handlers persist across reconnects — one registration.

import { useEffect } from "react";
import { listActiveSessions } from "../api/io";
import { useSessionStore } from "../stores/sessionStore";
import { wsTransport } from "../services/wsTransport";
import { MsgType } from "../services/wsProtocol";

export function useSessionRosterSync(): void {
  useEffect(() => {
    let cancelled = false;
    const reconcile = () => {
      listActiveSessions()
        .then((infos) => {
          if (!cancelled) useSessionStore.getState().registerKnownSessions(infos);
        })
        .catch(() => {});
    };

    reconcile(); // initial sync — catches sessions created before mount
    const unlistenLifecycle = wsTransport.onGlobalMessage(MsgType.SessionLifecycle, reconcile);
    // Re-sync after a WS reconnect: while the socket was down we may have missed
    // state/lifecycle events, leaving owned sessions frozen with stale state.
    const unlistenReconnect = wsTransport.onReconnect(reconcile);

    return () => {
      cancelled = true;
      unlistenLifecycle();
      unlistenReconnect();
    };
  }, []);
}
