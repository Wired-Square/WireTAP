import { describe, it, expect } from "vitest";

import * as ShareIcon from "../components/catalogIcons";
import { SYNC_STATUS_DRESS } from "../components/catalogIcons";

// The collision this vocabulary exists to prevent was invisible to every other check:
// lucide re-exports `UploadCloud` as an alias of `CloudUpload`, so the status glyph and
// the action glyph were the *same component* under two names. Grep could not see it,
// TypeScript could not see it, and on screen it was total. Comparing the resolved
// components is the only thing that catches it.

/** The vocabulary, minus the status record that shares the module. */
const actions = Object.entries(ShareIcon).filter(([name]) => name !== "SYNC_STATUS_DRESS");

describe("the catalogue icon vocabulary", () => {
  it("gives every action and object its own glyph", () => {
    const byGlyph = new Map<unknown, string[]>();
    for (const [name, icon] of actions) {
      byGlyph.set(icon, [...(byGlyph.get(icon) ?? []), name]);
    }
    const shared = [...byGlyph.values()].filter((names) => names.length > 1);
    expect(shared, `these names resolve to one glyph: ${JSON.stringify(shared)}`).toEqual([]);
  });

  it("gives every sync status its own glyph", () => {
    const glyphs = Object.values(SYNC_STATUS_DRESS).map((d) => d.Icon);
    expect(new Set(glyphs).size).toBe(glyphs.length);
  });

  // The two tables are separate vocabularies — a state and a verb may legitimately look
  // alike (`inSync` and `Success` are both a tick). What must never happen is a *state*
  // wearing a *transfer* glyph, which is the exact shape of the original defect: the
  // "Local ahead" pill and the "Push" menu item drawn identically.
  it("keeps state glyphs clear of the transfer verbs", () => {
    const transfers = [ShareIcon.Push, ShareIcon.Pull, ShareIcon.CheckUpdates];
    for (const [status, { Icon }] of Object.entries(SYNC_STATUS_DRESS)) {
      expect(transfers, `status "${status}" wears a transfer glyph`).not.toContain(Icon);
    }
  });

  it("dresses every status", () => {
    for (const [status, dress] of Object.entries(SYNC_STATUS_DRESS)) {
      expect(dress.Icon, status).toBeTruthy();
      expect(dress.tone, status).toBeTruthy();
      expect(dress.badge, status).toBeTruthy();
    }
  });
});
