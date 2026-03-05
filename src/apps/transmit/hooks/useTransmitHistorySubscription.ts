// src/apps/transmit/hooks/useTransmitHistorySubscription.ts
//
// Subscribes to transmit-related events from the backend.
// Handles replay lifecycle events and the transmit-history-updated notification
// that signals new rows have been written to the SQLite history database.

import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { useTransmitStore } from "../../../stores/transmitStore";
import { transmitHistoryCount } from "../../../api/transmitHistory";
import type {
  RepeatStoppedEvent,
  ReplayStartedEvent,
  ReplayProgressEvent,
  ReplayLoopRestartedEvent,
} from "../../../api/transmit";

/**
 * Subscribes to transmit history events and updates the store.
 *
 * Listens for:
 * - `transmit-history-updated`: SQLite rows written — refetch count
 * - `replay-started`: Replay began
 * - `replay-progress`: Replay frame count update
 * - `replay-loop-restarted`: Looping replay completed a pass and is restarting
 * - `repeat-stopped`: Repeating transmission or replay stopped
 */
export function useTransmitHistorySubscription(): void {
  const markRepeatStopped = useTransmitStore((s) => s.markRepeatStopped);
  const markReplayStopped = useTransmitStore((s) => s.markReplayStopped);
  const markReplayStarted = useTransmitStore((s) => s.markReplayStarted);
  const updateReplayProgress = useTransmitStore((s) => s.updateReplayProgress);
  const markReplayLoopRestarted = useTransmitStore((s) => s.markReplayLoopRestarted);

  useEffect(() => {
    // SQLite history updated — fetch the new count so TransmitHistoryView can refresh
    const unlistenHistoryUpdated = listen("transmit-history-updated", async () => {
      try {
        const count = await transmitHistoryCount();
        useTransmitStore.setState({ historyDbCount: count });
      } catch {
        // Non-critical — the view will still show whatever it last fetched
      }
    });

    // Replay lifecycle events
    const unlistenReplayStarted = listen<ReplayStartedEvent>(
      "replay-started",
      (event) => {
        const { replay_id, total_frames, speed, loop_replay } = event.payload;
        markReplayStarted(replay_id, total_frames, speed, loop_replay);
      }
    );

    const unlistenReplayProgress = listen<ReplayProgressEvent>(
      "replay-progress",
      (event) => {
        const { replay_id, frames_sent } = event.payload;
        updateReplayProgress(replay_id, frames_sent);
      }
    );

    const unlistenLoopRestarted = listen<ReplayLoopRestartedEvent>(
      "replay-loop-restarted",
      (event) => {
        const { replay_id, pass, frames_sent } = event.payload;
        markReplayLoopRestarted(replay_id, pass, frames_sent);
      }
    );

    // Repeat stopped events (due to permanent error or completion)
    const unlistenStopped = listen<RepeatStoppedEvent>(
      "repeat-stopped",
      (event) => {
        const data = event.payload;
        console.warn(
          `[Transmit] Repeat stopped for ${data.queue_id}: ${data.reason}`
        );
        // May be a queue repeat OR a replay — call both handlers (no-op if not applicable)
        markRepeatStopped(data.queue_id);
        markReplayStopped(data.queue_id, data.reason);
      }
    );

    return () => {
      unlistenHistoryUpdated.then((fn) => fn());
      unlistenReplayStarted.then((fn) => fn());
      unlistenReplayProgress.then((fn) => fn());
      unlistenLoopRestarted.then((fn) => fn());
      unlistenStopped.then((fn) => fn());
    };
  }, [markRepeatStopped, markReplayStopped, markReplayStarted, updateReplayProgress, markReplayLoopRestarted]);
}
