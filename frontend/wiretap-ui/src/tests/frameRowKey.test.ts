// Row identity for frame tables.
//
// Frames carry no identity of their own. The table used to key rows on
// `(timestamp_us, frame_id, bus)`, which collides whenever a source emits the same ID
// more than once in the same microsecond — and a duplicate key makes React's reconciler
// orphan <tr> nodes it can no longer remove, so they accumulate on every render.

import { describe, it, expect } from "vitest";
import { frameRowKey } from "../utils/frameKey";

describe("frameRowKey", () => {
  it("prefers the backend capture index", () => {
    expect(frameRowKey(40, 0)).toBe("cap:40");
  });

  it("falls back to the row's position when there is no capture index", () => {
    expect(frameRowKey(undefined, 103)).toBe("pos:103");
  });

  it("treats index 0 as a real capture index, not a missing one", () => {
    // The only branch with real risk: a falsy check here would send row 0 of every
    // capture down the fallback path.
    expect(frameRowKey(0, 7)).toBe("cap:0");
  });

  it("keeps rowids and positions in separate namespaces", () => {
    // Both are small integers; without namespacing, capture row 40 and list position 40
    // would collide.
    expect(frameRowKey(40, 0)).not.toBe(frameRowKey(undefined, 40));
  });
});
