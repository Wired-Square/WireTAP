// src/utils/captureEvents.ts

import type { CaptureEvent, EventOwner } from "../api/captureEvents";
import type { IOCapabilities } from "../api/io";
import type { IOProfile } from "../hooks/useSettings";
import { isTimeRangeCapableKind } from "./profileTraits";
import { formatHumanUs } from "./timeFormat";

interface SessionSource {
  /** The profile the session was opened from, when it differs from the session id. */
  sourceProfileId: string | null | undefined;
  ioProfile: string | null | undefined;
  profiles: IOProfile[];
  captureId: string | null | undefined;
}

/**
 * A backend session also streams into a local capture (its load window), so
 * the profile is tested first: the archive owns those events, not the copy.
 */
export function eventOwnerForSession({ sourceProfileId, ioProfile, profiles, captureId }: SessionSource): EventOwner | null {
  const profileId = sourceProfileId || ioProfile;
  const profile = profileId ? profiles.find((p) => p.id === profileId) : undefined;
  if (profile && isTimeRangeCapableKind(profile.kind)) {
    return { kind: "backend", profile_id: profile.id };
  }
  if (captureId) {
    return { kind: "capture", capture_id: captureId };
  }
  return null;
}

/** The note's first line, or the time when there is none. */
export function eventLabel(event: Pick<CaptureEvent, "note" | "timestampUs">, useLocalTimezone = true): string {
  const firstLine = event.note.split("\n")[0]?.trim();
  return firstLine || formatHumanUs(event.timestampUs, useLocalTimezone);
}

/** Seconds of context kept either side of an event when a recorded source is re-windowed. */
export const EVENT_WINDOW_PAD_US = 30_000_000;

export type EventJump =
  | { kind: "seek"; timestampUs: number }
  | { kind: "window"; startUtc: string; endUtc: string }
  | { kind: "none" };

/** A capture seeks, an archive re-windows around the whole span, a live source only marks. */
export function planEventJump(
  capabilities: Pick<IOCapabilities, "supports_seek" | "supports_time_range"> | null | undefined,
  event: Pick<CaptureEvent, "timestampUs" | "durationUs">
): EventJump {
  if (capabilities?.supports_seek) {
    return { kind: "seek", timestampUs: event.timestampUs };
  }
  if (capabilities?.supports_time_range) {
    const startUs = Math.max(0, event.timestampUs - EVENT_WINDOW_PAD_US);
    const endUs = event.timestampUs + event.durationUs + EVENT_WINDOW_PAD_US;
    return { kind: "window", startUtc: isoFromUs(startUs), endUtc: isoFromUs(endUs) };
  }
  return { kind: "none" };
}

function isoFromUs(us: number): string {
  return new Date(Math.floor(us / 1000)).toISOString();
}
