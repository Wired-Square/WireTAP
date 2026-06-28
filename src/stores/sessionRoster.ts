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
 *  - refreshes the authoritative fields (ioState, capabilities, subscriberCount,
 *    capture id/count) of entries already in the store from the roster — so a
 *    frontend that drifted (e.g. while the WS was down) re-syncs to Rust,
 *  - drops adopted (`external: true`) entries no longer in the roster.
 *
 * The roster is the backend's source of truth. The attached catalogue path is now
 * authoritative too (Rust reports it as `catalogPath`), so it's adopted here rather
 * than preserved. Remaining UI-only fields (speed, playback position, capture
 * name/persistence, queued-message flag) are preserved, and entries are only rebuilt
 * when an authoritative field actually changed, keeping object identity stable to
 * avoid needless re-renders.
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
    const existing = next[info.sessionId];
    if (existing) {
      // Already in the store (UI-owned or adopted) — refresh authoritative state.
      const captureCount = info.captureFrameCount ?? existing.capture.count;
      const frameCount = info.captureFrameCount ?? existing.frameCount;
      const uniqueFrameCount = info.captureUniqueFrameCount ?? existing.uniqueFrameCount;
      const catalogPath = info.catalogPath ?? null;
      const changed =
        existing.ioState !== info.state ||
        existing.subscriberCount !== info.subscriberCount ||
        existing.capture.id !== info.captureId ||
        existing.capture.count !== captureCount ||
        existing.frameCount !== frameCount ||
        existing.uniqueFrameCount !== uniqueFrameCount ||
        existing.catalogPath !== catalogPath;
      if (changed) {
        next[info.sessionId] = {
          ...existing,
          ioState: info.state,
          subscriberCount: info.subscriberCount,
          capabilities: info.capabilities ?? existing.capabilities,
          frameCount,
          uniqueFrameCount,
          catalogPath,
          capture: {
            ...existing.capture,
            id: info.captureId ?? existing.capture.id,
            count: captureCount,
          },
        };
      }
      continue;
    }
    next[info.sessionId] = {
      id: info.sessionId,
      profileId: info.sourceProfileIds[0] ?? "",
      profileName: info.brokerConfigs?.[0]?.displayName ?? info.sessionId,
      lifecycleState: "connected",
      ioState: info.state,
      capabilities: info.capabilities,
      errorMessage: null,
      subscriberCount: info.subscriberCount,
      frameCount: info.captureFrameCount ?? 0,
      uniqueFrameCount: info.captureUniqueFrameCount ?? 0,
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
      catalogPath: info.catalogPath ?? null,
      bytesCaptureId: null,
      external: true,
    };
  }

  return next;
}
