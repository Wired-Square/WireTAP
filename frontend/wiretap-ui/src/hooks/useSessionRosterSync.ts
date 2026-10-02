// Copyright 2026 Wired Square Pty Ltd
//
// Window-global session-roster sync. Adopts backend sessions (including
// agent/MCP-created ones) into useSessionStore as known-only entries, and holds
// the roster and profile usage, re-read on each global SessionLifecycle broadcast.

import { getProfilesUsage, listActiveSessions } from "../api/io";
import { useSessionStore } from "../stores/sessionStore";
import { useWsResync } from "./useWsResync";
import { MsgType } from "../services/wsProtocol";

export function useSessionRosterSync(): void {
  useWsResync(MsgType.SessionLifecycle, () => {
    const store = useSessionStore.getState();
    listActiveSessions().then(store.registerKnownSessions).catch(() => {});
    getProfilesUsage().then(store.registerProfileUsage).catch(() => {});
  });
}
