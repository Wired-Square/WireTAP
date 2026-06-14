// src/apps/transmit/hooks/useTransmitHistorySubscription.ts
//
// Subscribes to transmit-related events from the backend.
// Handles replay state updates and the transmit-updated notification
// that signals new rows have been written to the SQLite history database.

import { useEffect } from "react";
import { useTransmitStore } from "../../../stores/transmitStore";
import { wsTransport } from "../../../services/wsTransport";
import { MsgType, HEADER_SIZE, decodeTransmitUpdated } from "../../../services/wsProtocol";

const sharedTextDecoder = new TextDecoder();

/**
 * Subscribes to transmit history events and updates the store.
 *
 * WebSocket handlers for:
 * - TransmitUpdated (0x0B): SQLite rows written — refetch count
 * - ReplayState (0x0C): Replay lifecycle/progress — full state in JSON payload
 *
 * Repeat-transmit lifecycle (MsgType.RepeatEvent) is handled window-globally by
 * useRepeatQueueEvents, not here.
 */
export function useTransmitHistorySubscription(): void {
  const handleReplayLifecycle = useTransmitStore((s) => s.handleReplayLifecycle);
  const updateReplayProgress = useTransmitStore((s) => s.updateReplayProgress);

  useEffect(() => {
    const unlistenFns: (() => void)[] = [];

    // WS: TransmitUpdated — count is inlined in the binary payload
    if (wsTransport.isConnected) {
      unlistenFns.push(
        wsTransport.onGlobalMessage(MsgType.TransmitUpdated, (payload) => {
          const { count } = decodeTransmitUpdated(payload);
          useTransmitStore.setState({ historyDbCount: count });
        })
      );

      // WS: ReplayState — full replay state as JSON payload
      unlistenFns.push(
        wsTransport.onGlobalMessage(MsgType.ReplayState, (_payload, raw) => {
          try {
            const jsonBytes = new Uint8Array(raw, HEADER_SIZE);
            const text = sharedTextDecoder.decode(jsonBytes);
            const state = JSON.parse(text);
            if (state.status === "running" && state.frames_sent > 0) {
              updateReplayProgress(state);
            } else {
              handleReplayLifecycle(state);
            }
          } catch {
            // Malformed payload — ignore
          }
        })
      );
    }

    return () => {
      for (const fn of unlistenFns) fn();
    };
  }, [handleReplayLifecycle, updateReplayProgress]);
}
