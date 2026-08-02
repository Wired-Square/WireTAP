import { describe, it, expect } from "vitest";

import { hasLocalChanges, hasRemoteChanges } from "../utils/catalogSync";

// The status derivation these read is no longer here — it is
// `catalog_share::registry::SyncStatus::collapse`, covered by
// `sync_status_collapses_the_two_states_exactly_once` in registry.rs, with the
// wire strings pinned by `sync_status_serialises_as_the_ui_union`.

describe("change predicates", () => {
  it("offers a push only when there is something local to send", () => {
    expect(hasLocalChanges("localAhead")).toBe(true);
    // Diverged claims both directions — a row offering only one action there would
    // hide half the problem.
    expect(hasLocalChanges("diverged")).toBe(true);
    expect(hasLocalChanges("inSync")).toBe(false);
    expect(hasLocalChanges("remoteAhead")).toBe(false);
    expect(hasLocalChanges("localOnly")).toBe(false);
  });

  it("offers a pull only when there is something upstream to take", () => {
    expect(hasRemoteChanges("remoteAhead")).toBe(true);
    expect(hasRemoteChanges("diverged")).toBe(true);
    expect(hasRemoteChanges("inSync")).toBe(false);
    expect(hasRemoteChanges("localAhead")).toBe(false);
    expect(hasRemoteChanges("unchecked")).toBe(false);
  });
});
