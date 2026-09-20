// Who owns a session's events, and how a jump to one is carried out.
//
// A backend session also streams into a local capture, so the profile must win over
// the capture id; a capture seeks, an archive re-windows, a live source only marks.

import { describe, it, expect } from "vitest";
import { eventOwnerForSession, eventLabel, planEventJump, EVENT_WINDOW_PAD_US } from "../utils/captureEvents";
import { markerPercent } from "../components/TimelineScrubber";
import type { IOProfile } from "../hooks/useSettings";

const backend: IOProfile = { id: "wt1", name: "Bendigo", kind: "wiretap", connection: {} };
const gvret: IOProfile = { id: "gv1", name: "Bridge", kind: "gvret_tcp", connection: {} };
const profiles = [backend, gvret];

describe("eventOwnerForSession", () => {
  it("gives a WireTAP Backend profile's events to the archive, not its load-window capture", () => {
    expect(eventOwnerForSession({ sourceProfileId: "wt1", ioProfile: "t_abc", profiles, captureId: "xk9m2p" }))
      .toEqual({ kind: "backend", profile_id: "wt1" });
  });

  it("falls back to the source profile id when the session id is the profile", () => {
    expect(eventOwnerForSession({ sourceProfileId: null, ioProfile: "wt1", profiles, captureId: null }))
      .toEqual({ kind: "backend", profile_id: "wt1" });
  });

  it("gives a realtime session's events to its live capture", () => {
    expect(eventOwnerForSession({ sourceProfileId: null, ioProfile: "gv1", profiles, captureId: "xk9m2p" }))
      .toEqual({ kind: "capture", capture_id: "xk9m2p" });
  });

  it("has no owner before a capture exists", () => {
    expect(eventOwnerForSession({ sourceProfileId: null, ioProfile: "gv1", profiles, captureId: null })).toBeNull();
    expect(eventOwnerForSession({ sourceProfileId: null, ioProfile: null, profiles, captureId: null })).toBeNull();
  });
});

describe("planEventJump", () => {
  const event = { timestampUs: 1_700_000_000_000_000, durationUs: 5_000_000 };

  it("seeks when the source can", () => {
    expect(planEventJump({ supports_seek: true, supports_time_range: true }, event))
      .toEqual({ kind: "seek", timestampUs: event.timestampUs });
  });

  it("re-windows a recorded source around the whole span", () => {
    const jump = planEventJump({ supports_seek: false, supports_time_range: true }, event);
    expect(jump.kind).toBe("window");
    if (jump.kind !== "window") return;
    expect(new Date(jump.startUtc).getTime() * 1000).toBe(event.timestampUs - EVENT_WINDOW_PAD_US);
    expect(new Date(jump.endUtc).getTime() * 1000).toBe(event.timestampUs + event.durationUs + EVENT_WINDOW_PAD_US);
  });

  it("does nothing on a live source", () => {
    expect(planEventJump({ supports_seek: false, supports_time_range: false }, event)).toEqual({ kind: "none" });
    expect(planEventJump(null, event)).toEqual({ kind: "none" });
  });
});

describe("markerPercent", () => {
  it("places a time along the track and clamps outside it", () => {
    expect(markerPercent(150, 100, 200)).toBe(50);
    expect(markerPercent(50, 100, 200)).toBe(0);
    expect(markerPercent(250, 100, 200)).toBe(100);
  });

  it("has nowhere to put a marker on an empty range", () => {
    expect(markerPercent(100, 100, 100)).toBeNull();
  });
});

describe("eventLabel", () => {
  it("uses the note's first line, else the time", () => {
    expect(eventLabel({ note: "Pump tripped\nsecond line", timestampUs: 0 })).toBe("Pump tripped");
    expect(eventLabel({ note: "  ", timestampUs: 1_700_000_000_000_000 }, false)).toMatch(/^2023-11-14/);
  });
});
