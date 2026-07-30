// Copyright 2026 Wired Square Pty Ltd
//
// Window-global session-roster sync. Adopts backend sessions (including
// agent/MCP-created ones) into useSessionStore as known-only entries by reconciling
// against listActiveSessions() on each global SessionLifecycle broadcast.

import { listActiveSessions } from "../api/io";
import { useSessionStore } from "../stores/sessionStore";
import { useWsResync } from "./useWsResync";
import { MsgType } from "../services/wsProtocol";

export function useSessionRosterSync(): void {
  useWsResync(MsgType.SessionLifecycle, () => {
    listActiveSessions()
      .then((infos) => useSessionStore.getState().registerKnownSessions(infos))
      .catch(() => {});
  });
}
