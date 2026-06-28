// Copyright 2026 Wired Square Pty Ltd
//
// Window-global open-app roster sync. Reconciles useOpenAppsStore against
// listOpenApps() on each global OpenAppsChanged broadcast, so the Session Manager
// graph shows open apps from every window — not just the current one. Mirrors
// useSessionRosterSync. Global handlers persist across reconnects — one registration.

import { useEffect } from "react";
import { listOpenApps } from "../api/io";
import { useOpenAppsStore } from "../stores/openAppsStore";
import { wsTransport } from "../services/wsTransport";
import { MsgType } from "../services/wsProtocol";

export function useOpenAppsSync(): void {
  useEffect(() => {
    let cancelled = false;
    const reconcile = () => {
      listOpenApps()
        .then((instances) => {
          if (!cancelled) useOpenAppsStore.getState().setInstances(instances);
        })
        .catch(() => {});
    };

    reconcile(); // initial sync — catches apps registered before mount
    const unlistenChanged = wsTransport.onGlobalMessage(MsgType.OpenAppsChanged, reconcile);
    // Re-sync after a WS reconnect: while the socket was down we may have missed
    // roster changes from other windows.
    const unlistenReconnect = wsTransport.onReconnect(reconcile);

    return () => {
      cancelled = true;
      unlistenChanged();
      unlistenReconnect();
    };
  }, []);
}
