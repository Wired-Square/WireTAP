import { describe, it, expect } from "vitest";

import { catalogSyncStatus, hasLocalChanges, hasRemoteChanges } from "../utils/catalogSync";
import type { LocalState, RemoteState, TrackedCatalog } from "../api/catalogShare";

/** A tracked catalogue in whatever sync state the case under test needs. */
function tracked(localState: LocalState, remoteState: RemoteState): TrackedCatalog {
  return {
    id: "cs_x",
    localFilename: "sbrxxx.toml",
    repoId: "gh:wiredsquare/decoders",
    repoLabel: "wiredsquare/decoders",
    remotePath: "catalogs/sbrxxx.toml",
    gitRef: "main",
    localState,
    remoteState,
    prMerged: false,
  };
}

describe("catalogSyncStatus", () => {
  it("reports a catalogue with no provenance as local only", () => {
    expect(catalogSyncStatus(undefined)).toBe("localOnly");
  });

  it("reports a clean, checked copy as in sync", () => {
    expect(catalogSyncStatus(tracked("committed", "inSync"))).toBe("inSync");
  });

  it("distinguishes never-checked from checked-and-in-sync", () => {
    // Both look clean locally; only one of them has actually been compared with the
    // repository, and claiming "in sync" for the other would be a lie.
    expect(catalogSyncStatus(tracked("committed", "unknown"))).toBe("unchecked");
  });

  it("reports local edits as local ahead", () => {
    expect(catalogSyncStatus(tracked("modified", "inSync"))).toBe("localAhead");
    // Unchecked but edited is still unambiguously "I have changes to push".
    expect(catalogSyncStatus(tracked("modified", "unknown"))).toBe("localAhead");
  });

  it("reports a moved repository over a clean copy as remote ahead", () => {
    expect(catalogSyncStatus(tracked("committed", "upstreamAhead"))).toBe("remoteAhead");
  });

  it("reports divergence whatever the local state says", () => {
    expect(catalogSyncStatus(tracked("modified", "diverged"))).toBe("diverged");
    expect(catalogSyncStatus(tracked("committed", "diverged"))).toBe("diverged");
  });

  it("lets a missing file outrank every other comparison", () => {
    // There is nothing on disk to compare, so every other label would be fiction.
    expect(catalogSyncStatus(tracked("missing", "upstreamAhead"))).toBe("missing");
    expect(catalogSyncStatus(tracked("missing", "diverged"))).toBe("missing");
    expect(catalogSyncStatus(tracked("missing", "inSync"))).toBe("missing");
  });
});

describe("change predicates", () => {
  it("finds local changes only where there is something to push", () => {
    expect(hasLocalChanges("localAhead")).toBe(true);
    expect(hasLocalChanges("diverged")).toBe(true);
    expect(hasLocalChanges("inSync")).toBe(false);
    expect(hasLocalChanges("remoteAhead")).toBe(false);
    expect(hasLocalChanges("localOnly")).toBe(false);
  });

  it("finds remote changes only where there is something to take", () => {
    expect(hasRemoteChanges("remoteAhead")).toBe(true);
    expect(hasRemoteChanges("diverged")).toBe(true);
    expect(hasRemoteChanges("inSync")).toBe(false);
    expect(hasRemoteChanges("localAhead")).toBe(false);
  });
});
