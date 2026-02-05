// src/apps/transmit/hooks/useTransmitHistorySubscription.ts
//
// Subscribes to transmit history events from the backend.
// Handles CAN transmit, serial transmit, and repeat-stopped events.

import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { useTransmitStore } from "../../../stores/transmitStore";
import type {
  TransmitHistoryEvent,
  SerialTransmitHistoryEvent,
  RepeatStoppedEvent,
} from "../../../api/transmit";

interface UseTransmitHistorySubscriptionParams {
  /** Profile name to use in history entries (falls back to session ID) */
  profileName: string | null;
}

/**
 * Subscribes to transmit history events and updates the store.
 *
 * Listens for:
 * - `transmit-history`: CAN frame transmission results
 * - `serial-transmit-history`: Serial byte transmission results
 * - `repeat-stopped`: Notification when a repeating transmission is stopped
 */
export function useTransmitHistorySubscription({
  profileName,
}: UseTransmitHistorySubscriptionParams): void {
  const addHistoryItem = useTransmitStore((s) => s.addHistoryItem);
  const markRepeatStopped = useTransmitStore((s) => s.markRepeatStopped);

  useEffect(() => {
    // CAN transmit history events
    const unlistenCan = listen<TransmitHistoryEvent>(
      "transmit-history",
      (event) => {
        const data = event.payload;
        addHistoryItem({
          timestamp_us: data.timestamp_us,
          profileId: data.session_id,
          profileName: profileName ?? data.session_id,
          type: "can",
          frame: data.frame,
          success: data.success,
          error: data.error,
        });
      }
    );

    // Serial transmit history events
    const unlistenSerial = listen<SerialTransmitHistoryEvent>(
      "serial-transmit-history",
      (event) => {
        const data = event.payload;
        addHistoryItem({
          timestamp_us: data.timestamp_us,
          profileId: data.session_id,
          profileName: profileName ?? data.session_id,
          type: "serial",
          bytes: data.bytes,
          success: data.success,
          error: data.error,
        });
      }
    );

    // Repeat stopped events (due to permanent error)
    const unlistenStopped = listen<RepeatStoppedEvent>(
      "repeat-stopped",
      (event) => {
        const data = event.payload;
        console.warn(
          `[Transmit] Repeat stopped for ${data.queue_id}: ${data.reason}`
        );
        markRepeatStopped(data.queue_id);
      }
    );

    return () => {
      unlistenCan.then((fn) => fn());
      unlistenSerial.then((fn) => fn());
      unlistenStopped.then((fn) => fn());
    };
  }, [addHistoryItem, markRepeatStopped, profileName]);
}
