// Copyright 2026 Wired Square Pty Ltd
//
// Window-global handler for repeat-transmit lifecycle events. Repeat start/stop
// ride the WebSocket push channel (MsgType.RepeatEvent); this hook mirrors them
// into the shared transmit queue and opens the Transmit panel so an
// agent-started repeat is visible regardless of which tab is focused.

import { useEffect } from "react";
import { useTransmitStore } from "../stores/transmitStore";
import { wsTransport } from "../services/wsTransport";
import { MsgType, decodeWsJson } from "../services/wsProtocol";
import { openPanel } from "../utils/windowCommunication";
import type { RepeatEvent } from "../api/transmit";

const TRANSMIT_PANEL_ID = "transmit";

/**
 * Mounted once per window (from MainLayout). Drives `transmitStore` — the single
 * source of truth — from the WebSocket repeat-lifecycle channel. On `started` it
 * upserts the queue row (idempotent) and opens the Transmit panel; on `stopped`
 * it marks the row stopped, covering agent stops and permanent-error stops for
 * UI and agent repeats alike. Global handlers persist across reconnects, so a
 * single registration is enough.
 */
export function useRepeatQueueEvents(): void {
  useEffect(
    () =>
      wsTransport.onGlobalMessage(MsgType.RepeatEvent, (_payload, raw) => {
        let event: RepeatEvent;
        try {
          event = decodeWsJson<RepeatEvent>(raw);
        } catch {
          return;
        }

        const store = useTransmitStore.getState();
        if (event.kind === "started") {
          store.addExternalRepeat(event);
          openPanel(TRANSMIT_PANEL_ID);
        } else {
          console.warn(
            `[Transmit] Repeat stopped for ${event.queue_id}: ${event.reason}`
          );
          store.markRepeatStopped(event.queue_id);
        }
      }),
    []
  );
}
