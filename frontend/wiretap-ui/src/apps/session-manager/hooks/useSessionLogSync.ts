// Copyright 2026 Wired Square Pty Ltd

import { useEffect } from "react";
import { getSessionLog } from "../../../api/io";
import { wsTransport } from "../../../services/wsTransport";
import { decodeWsJson, MsgType } from "../../../services/wsProtocol";
import type { SessionLogEntry } from "../../../generated/SessionLogEntry";
import { lastEntryId, useSessionLogStore } from "../stores/sessionLogStore";

/** Keep this window's copy of the session log level with the Rust ring: read on mount and reconnect, then take each push. */
export function useSessionLogSync(): void {
  useEffect(() => {
    const { ingest } = useSessionLogStore.getState();
    const catchUp = () => {
      getSessionLog(lastEntryId(useSessionLogStore.getState().entries))
        .then(ingest)
        .catch(() => {});
    };
    catchUp();
    const offAppended = wsTransport.onGlobalMessage(MsgType.SessionLogAppended, (_payload, raw) => {
      ingest([decodeWsJson<SessionLogEntry>(raw)]);
    });
    const offReconnect = wsTransport.onReconnect(catchUp);
    return () => {
      offAppended();
      offReconnect();
    };
  }, []);
}
