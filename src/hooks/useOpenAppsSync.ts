// Copyright 2026 Wired Square Pty Ltd
//
// Window-global open-app roster sync. Reconciles useOpenAppsStore against
// listOpenApps() on each global OpenAppsChanged broadcast, so the Session Manager
// graph shows open apps from every window — not just the current one.

import { listOpenApps } from "../api/io";
import { useOpenAppsStore } from "../stores/openAppsStore";
import { useWsResync } from "./useWsResync";
import { MsgType } from "../services/wsProtocol";

export function useOpenAppsSync(): void {
  useWsResync(MsgType.OpenAppsChanged, () => {
    listOpenApps()
      .then((instances) => useOpenAppsStore.getState().setInstances(instances))
      .catch(() => {});
  });
}
