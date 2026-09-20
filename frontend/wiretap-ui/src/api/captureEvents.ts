// src/api/captureEvents.ts
//
// Events — a moment (or a span) and a note, owned by the stored capture.
// A local capture keeps its own; a WireTAP Backend profile's database keeps
// them on the gateway. Both answer through the same Rust commands.

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export interface CaptureEvent {
  id: string;
  timestampUs: number;
  /** 0 marks an instant; anything more is a span from `timestampUs`. */
  durationUs: number;
  note: string;
  createdAtUs: number;
  updatedAtUs: number;
}

export type EventOwner =
  | { kind: "capture"; capture_id: string }
  | { kind: "backend"; profile_id: string };

/** The editable part of an event. */
export type EventDraft = Pick<CaptureEvent, "timestampUs" | "durationUs" | "note">;

export function listCaptureEvents(owner: EventOwner): Promise<CaptureEvent[]> {
  return invoke<CaptureEvent[]>("capture_events_list", { owner });
}

export function addCaptureEvent(owner: EventOwner, draft: EventDraft): Promise<CaptureEvent> {
  return invoke<CaptureEvent>("capture_events_add", { owner, ...draft });
}

export function updateCaptureEvent(owner: EventOwner, id: string, draft: EventDraft): Promise<CaptureEvent> {
  return invoke<CaptureEvent>("capture_events_update", { owner, id, ...draft });
}

export function deleteCaptureEvent(owner: EventOwner, id: string): Promise<void> {
  return invoke("capture_events_delete", { owner, id });
}

/** Fires in every window after any mutation, with the owner that changed. */
export function onCaptureEventsChanged(callback: (owner: EventOwner) => void): Promise<UnlistenFn> {
  return listen<EventOwner>("capture-events-changed", (event) => callback(event.payload));
}
