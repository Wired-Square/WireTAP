// Copyright 2026 Wired Square Pty Ltd
//
// Window-global handler for the AttachToPanel WS push: open/focus a source-aware
// tab and point it at the requested session. Reconciles the roster first so the
// session is known before the join is requested (avoids the auto-join guard
// skipping a not-yet-adopted session).

import { useEffect } from "react";
import { listActiveSessions } from "../api/io";
import { useSessionStore } from "../stores/sessionStore";
import { wsTransport } from "../services/wsTransport";
import { MsgType, decodeWsJson, type AttachToPanelMsg } from "../services/wsProtocol";
import { openPanel } from "../utils/windowCommunication";
import { sessionAwarePanelIds } from "../apps/registry";

export function useAttachSourceEvents(): void {
  useEffect(
    () =>
      wsTransport.onGlobalMessage(MsgType.AttachToPanel, (_payload, raw) => {
        let msg: AttachToPanelMsg;
        try {
          msg = decodeWsJson<AttachToPanelMsg>(raw);
        } catch {
          return;
        }
        const { panel, session_id: sessionId } = msg;
        if (!sessionId || !sessionAwarePanelIds.has(panel)) return;

        const store = useSessionStore.getState();
        const attach = () => {
          store.requestSessionJoin(panel, sessionId);
          openPanel(panel);
        };
        // Ensure the session is in the store before requesting the join.
        listActiveSessions()
          .then((infos) => {
            store.registerKnownSessions(infos);
            attach();
          })
          .catch(attach);
      }),
    []
  );
}
