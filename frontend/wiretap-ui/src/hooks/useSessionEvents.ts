// src/hooks/useSessionEvents.ts
//
// Everything an app needs to show, mark and jump to a session's events: the
// list, the scrubber markers, the add/edit draft and the native menu's config.

import { useCallback, useMemo, useState } from "react";
import {
  addCaptureEvent,
  updateCaptureEvent,
  type CaptureEvent,
  type EventDraft,
  type EventOwner,
} from "../api/captureEvents";
import type { IOCapabilities } from "../api/io";
import type { TimelineMarkers } from "../components/TimelineScrubber";
import { eventLabel, planEventJump } from "../utils/captureEvents";
import { useCaptureEvents } from "./useCaptureEvents";

/** A draft with an id edits that event; without one it adds. */
export type EventDialogDraft = EventDraft & { id?: string };

interface Options {
  owner: EventOwner | null;
  capabilities: IOCapabilities | null | undefined;
  /** A capture seeks — the reader answers with a position even while stopped. */
  seek: (timestampUs: number) => Promise<void>;
  /** A recorded archive re-windows around the event. */
  jumpToTimeRange: (startUtc: string, endUtc?: string) => Promise<void>;
  useLocalTimezone: boolean;
  onError?: (message: string) => void;
}

export function useSessionEvents({ owner, capabilities, seek, jumpToTimeRange, useLocalTimezone, onError }: Options) {
  const { events, error } = useCaptureEvents(owner);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<EventDialogDraft | null>(null);

  const jumpToEvent = useCallback(
    async (event: CaptureEvent) => {
      setSelectedId(event.id);
      const jump = planEventJump(capabilities, event);
      if (jump.kind === "seek") await seek(jump.timestampUs);
      else if (jump.kind === "window") await jumpToTimeRange(jump.startUtc, jump.endUtc);
    },
    [capabilities, seek, jumpToTimeRange]
  );
  const jumpToEventId = useCallback(
    (id: string) => {
      const event = events.find((e) => e.id === id);
      if (event) void jumpToEvent(event);
    },
    [events, jumpToEvent]
  );

  const items = useMemo(
    () => events.map((e) => ({ id: e.id, timeUs: e.timestampUs, durationUs: e.durationUs, label: eventLabel(e, useLocalTimezone) })),
    [events, useLocalTimezone]
  );
  const markers = useMemo<TimelineMarkers>(
    () => ({ items, activeId: selectedId, onSelect: jumpToEventId }),
    [items, selectedId, jumpToEventId]
  );

  const openAdd = useCallback((timestampUs: number) => setDraft({ timestampUs, durationUs: 0, note: "" }), []);
  const openEdit = useCallback(
    (event: CaptureEvent) => setDraft({ id: event.id, timestampUs: event.timestampUs, durationUs: event.durationUs, note: event.note }),
    []
  );
  const closeDraft = useCallback(() => setDraft(null), []);
  const save = useCallback(
    async (values: EventDraft) => {
      if (!owner) return;
      try {
        if (draft?.id) {
          await updateCaptureEvent(owner, draft.id, values);
        } else {
          setSelectedId((await addCaptureEvent(owner, values)).id);
        }
      } catch (e) {
        onError ? onError(String(e)) : console.error("[useSessionEvents] save failed:", e);
      }
    },
    [owner, draft?.id, onError]
  );

  const canJump = !!capabilities?.supports_seek || !!capabilities?.supports_time_range;
  const menu = useMemo(() => ({ owner, events }), [owner, events]);

  return { events, error, canJump, selectedId, setSelectedId, jumpToEvent, jumpToEventId, markers, menu, draft, openAdd, openEdit, closeDraft, save };
}
