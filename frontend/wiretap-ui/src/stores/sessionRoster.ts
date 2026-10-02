// Copyright 2026 Wired Square Pty Ltd
//
// Reconcile the backend session roster (listActiveSessions) into the per-app
// session store as "known-only" entries: present, connected, capability-aware,
// but NOT subscribed to frames. A panel watching the session is what subscribes.

import type { Session } from "./sessionStore";
import { getStateType, type ActiveSessionInfo } from "../api/io";

/** A session's capture slot before anything is known about the capture — or with
 *  only its id, as the CaptureChanged message reports it. */
export function emptyCapture(id: string | null = null, owningSessionId: string | null = null): Session["capture"] {
  return {
    available: id !== null,
    id,
    kind: id ? "frames" : null,
    count: 0,
    owningSessionId,
    startTimeUs: null,
    endTimeUs: null,
    name: null,
    persistent: false,
  };
}

/**
 * Returns a new sessions map that:
 *  - adds a known-only `Session` for each roster session the store doesn't own,
 *  - refreshes the authoritative fields (ioState, capabilities, subscriberCount,
 *    capture id/count) of entries already in the store from the roster — so a
 *    frontend that drifted (e.g. while the WS was down) re-syncs to Rust,
 *  - drops adopted (`external: true`) entries no longer in the roster.
 *
 * The roster is the backend's source of truth. The attached catalogue path is now
 * authoritative too (Rust reports it as `catalog_path`), so it's adopted here rather
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
  const rosterIds = new Set(infos.map((i) => i.session_id));

  for (const [id, sess] of Object.entries(next)) {
    if (sess?.external && !rosterIds.has(id)) delete next[id];
  }

  for (const info of infos) {
    const ioState = getStateType(info.state);
    const existing = next[info.session_id];
    if (existing) {
      // Already in the store (UI-owned or adopted) — refresh authoritative state.
      const captureCount = info.capture_frame_count ?? existing.capture.count;
      const captureKind = info.capture_kind ?? existing.capture.kind;
      const frameCount = info.capture_frame_count ?? existing.frameCount;
      const uniqueFrameCount = info.capture_unique_frame_count ?? existing.uniqueFrameCount;
      const catalogPath = info.catalog_path ?? null;
      const paused = info.paused_source_profile_ids;
      const origin = info.origin_profile_ids;
      const changed =
        existing.ioState !== ioState ||
        existing.subscriberCount !== info.subscriber_count ||
        existing.capture.id !== info.capture_id ||
        existing.capture.kind !== captureKind ||
        existing.capture.count !== captureCount ||
        existing.frameCount !== frameCount ||
        existing.uniqueFrameCount !== uniqueFrameCount ||
        existing.sourceType !== info.source_type ||
        // Rust sorts this list, so comparing the joined form is a real
        // comparison rather than an accident of map iteration order.
        existing.pausedSourceProfileIds.join() !== paused.join() ||
        existing.originProfileIds.join() !== origin.join() ||
        existing.sourceKind !== info.source_kind ||
        existing.mode !== info.mode ||
        // `catalogPath` is normalised to null when the roster omits it, so
        // normalise the existing side too — an absent (undefined) path must not
        // read as a change against null and rebuild the entry every reconcile.
        (existing.catalogPath ?? null) !== catalogPath;
      if (changed) {
        next[info.session_id] = {
          ...existing,
          ioState,
          subscriberCount: info.subscriber_count,
          capabilities: info.capabilities ?? existing.capabilities,
          frameCount,
          uniqueFrameCount,
          catalogPath,
          sourceType: info.source_type,
          pausedSourceProfileIds: paused,
          originProfileIds: origin,
          sourceKind: info.source_kind,
          mode: info.mode,
          capture: {
            ...existing.capture,
            id: info.capture_id ?? existing.capture.id,
            // Kind comes from the roster alongside the id. Adopting one without the
            // other is what let a byte capture be rendered as frames.
            kind: captureKind,
            count: captureCount,
          },
        };
      }
      continue;
    }
    next[info.session_id] = {
      id: info.session_id,
      profileId: info.source_profile_ids[0] ?? "",
      profileName: info.broker_configs?.[0]?.display_name ?? info.session_id,
      lifecycleState: "connected",
      ioState,
      capabilities: info.capabilities,
      errorMessage: null,
      subscriberCount: info.subscriber_count,
      frameCount: info.capture_frame_count ?? 0,
      uniqueFrameCount: info.capture_unique_frame_count ?? 0,
      // Adopted from the roster, which reports frame counts only. Rust re-pushes the byte
      // total on its next signal if this session has a byte capture.
      byteCount: 0,
      capture: { ...emptyCapture(), id: info.capture_id, kind: info.capture_kind, count: info.capture_frame_count ?? 0 },
      createdAt: Date.now(),
      hasQueuedMessages: false,
      speed: null,
      playbackPosition: null,
      catalogPath: info.catalog_path ?? null,
      bytesCaptureId: null,
      sourceType: info.source_type,
      pausedSourceProfileIds: info.paused_source_profile_ids,
      originProfileIds: info.origin_profile_ids,
      sourceKind: info.source_kind,
      mode: info.mode,
      external: true,
    };
  }

  return next;
}
