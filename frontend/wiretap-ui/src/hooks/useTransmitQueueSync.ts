// Copyright 2026 Wired Square Pty Ltd

import { useEffect } from "react";
import { useTransmitStore } from "../stores/transmitStore";
import { wsTransport } from "../services/wsTransport";
import { MsgType, decodeWsJson } from "../services/wsProtocol";
import { openPanel } from "../utils/windowCommunication";
import { getTransmitQueue, type QueueRow, type TransmitQueue } from "../api/transmit";

const TRANSMIT_PANEL_ID = "transmit";

/** An agent's repeat that was not sending before, so the human sees it start. */
const agentStarted = (before: QueueRow[], after: QueueRow[]) =>
  after.some((row) => row.origin === "agent" && row.repeating && !before.some((b) => b.id === row.id && b.repeating));

/**
 * Mounted once per window (from MainLayout): keeps this window's view of the
 * Transmit queue level with Rust's — read on mount and reconnect, then each push.
 */
export function useTransmitQueueSync(): void {
  useEffect(() => {
    const catchUp = () => {
      getTransmitQueue().then(useTransmitStore.getState().applyQueue).catch(() => {});
    };
    catchUp();
    const offPush = wsTransport.onGlobalMessage(MsgType.TransmitQueue, (_payload, raw) => {
      const { queue: before, applyQueue } = useTransmitStore.getState();
      applyQueue(decodeWsJson<TransmitQueue>(raw));
      if (agentStarted(before, useTransmitStore.getState().queue)) openPanel(TRANSMIT_PANEL_ID);
    });
    const offReconnect = wsTransport.onReconnect(catchUp);
    return () => {
      offPush();
      offReconnect();
    };
  }, []);
}
