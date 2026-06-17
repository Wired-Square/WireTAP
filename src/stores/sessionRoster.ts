// Copyright 2026 Wired Square Pty Ltd
//
// Reconcile the backend session roster (listActiveSessions) into the per-app
// session store as "known-only" entries: present, connected, capability-aware,
// but NOT subscribed to frames. A panel watching the session is what subscribes.

import type { Session } from "./sessionStore";
import type { ActiveSessionInfo } from "../api/io";

/**
 * Returns a new sessions map that:
 *  - adds a known-only `Session` for each roster session the store doesn't own,
 *  - leaves UI-owned entries (`external` falsy) untouched,
 *  - drops adopted (`external: true`) entries no longer in the roster.
 */
export function reconcileKnownSessions(
  current: Record<string, Session>,
  infos: ActiveSessionInfo[]
): Record<string, Session> {
  const next: Record<string, Session> = { ...current };
  const rosterIds = new Set(infos.map((i) => i.sessionId));

  for (const [id, sess] of Object.entries(next)) {
    if (sess?.external && !rosterIds.has(id)) delete next[id];
  }

  for (const info of infos) {
    if (next[info.sessionId]) continue; // UI-owned or already adopted — leave it
    next[info.sessionId] = {
      id: info.sessionId,
      profileId: info.sourceProfileIds[0] ?? "",
      profileName: info.brokerConfigs?.[0]?.displayName ?? info.sessionId,
      lifecycleState: "connected",
      ioState: info.state,
      capabilities: info.capabilities,
      errorMessage: null,
      subscriberCount: info.subscriberCount,
      capture: {
        available: false,
        id: info.captureId,
        kind: null,
        count: info.captureFrameCount ?? 0,
        owningSessionId: null,
        startTimeUs: null,
        endTimeUs: null,
        name: null,
        persistent: false,
      },
      createdAt: Date.now(),
      hasQueuedMessages: false,
      stoppedExplicitly: false,
      streamEndedReason: null,
      speed: null,
      playbackPosition: null,
      catalogPath: null,
      bytesCaptureId: null,
      external: true,
    };
  }

  return next;
}
