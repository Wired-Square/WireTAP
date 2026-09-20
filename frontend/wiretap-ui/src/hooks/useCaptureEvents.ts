// src/hooks/useCaptureEvents.ts
//
// The events of one owner, kept current across windows: every mutation the
// backend broadcasts for this owner triggers a reload. A Tauri event rather
// than a WS push because the owner — not a session — is what changed.

import { useEffect, useState } from "react";
import { listCaptureEvents, onCaptureEventsChanged, type CaptureEvent, type EventOwner } from "../api/captureEvents";
import { tlog } from "../api/settings";

export const NO_EVENTS: CaptureEvent[] = [];

function ownerKey(owner: EventOwner | null): string | null {
  if (!owner) return null;
  return owner.kind === "capture" ? `capture:${owner.capture_id}` : `backend:${owner.profile_id}`;
}

export function useCaptureEvents(owner: EventOwner | null) {
  const [events, setEvents] = useState<CaptureEvent[]>(NO_EVENTS);
  const [error, setError] = useState<string | null>(null);
  const key = ownerKey(owner);

  useEffect(() => {
    if (!owner) {
      setEvents(NO_EVENTS);
      setError(null);
      return;
    }
    let cancelled = false;
    const load = () =>
      listCaptureEvents(owner).then(
        (loaded) => {
          if (cancelled) return;
          setEvents(loaded);
          setError(null);
        },
        (e) => {
          if (cancelled) return;
          tlog.debug(`[useCaptureEvents] load failed for ${key}: ${e}`);
          setEvents(NO_EVENTS);
          setError(String(e));
        }
      );
    void load();
    const unlisten = onCaptureEventsChanged((changed) => {
      if (ownerKey(changed) === key) void load();
    });
    return () => {
      cancelled = true;
      void unlisten.then((fn) => fn());
    };
    // The owner object is rebuilt each render; its key says when it actually changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return { events, error };
}
