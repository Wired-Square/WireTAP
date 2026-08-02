import { describe, it, expect } from "vitest";

import { publishBlockers } from "../apps/catalog/dialogs/publish/publishBlockers";
import type { PublishDiff, PublishPlan } from "../api/catalogShare";

/** Interpolates the key with its options, so a test can assert what reached the UI. */
const t = (key: string, options?: Record<string, unknown>) =>
  options ? `${key}(${JSON.stringify(options)})` : key;

/** A plan that blocks nothing, overridden per case. */
function plan(over: Partial<PublishPlan> = {}): PublishPlan {
  return {
    upstream: "wiredsquare/decoders",
    targetPath: "catalogs/sbrxxx.toml",
    branch: "main",
    baseBranch: "main",
    suggestedBranch: "catalog/sbrxxx",
    branches: ["main", "v2-dev"],
    localBlobSha: "aaa",
    baseBlobSha: "bbb",
    forkNeeded: false,
    targetIsPublic: false,
    contentBytes: 31391,
    validationErrors: [],
    secretFindings: [],
    transmitFrameCount: 0,
    ...over,
  };
}

/** The loaded comparison, defaulting to "there is a real change". */
function diff(over: Partial<PublishDiff> = {}): PublishDiff {
  return {
    comparedRef: "main",
    branchExists: true,
    targetPath: "catalogs/sbrxxx.toml",
    lines: [],
    added: 3,
    removed: 1,
    exists: true,
    identical: false,
    upstreamMoved: false,
    lastChange: null,
    ...over,
  };
}

/** Defaults for a clean direct push, so each case states only what it changes. */
function blockers(over: Partial<Parameters<typeof publishBlockers>[0]> = {}) {
  return publishBlockers({
    plan: plan(),
    openPr: false,
    effectiveBranch: "main",
    effectivePath: "catalogs/sbrxxx.toml",
    secretsAcknowledged: false,
    diff: null,
    t,
    ...over,
  });
}

describe("publishBlockers", () => {
  it("reports nothing before preflight has answered", () => {
    expect(blockers({ plan: null })).toEqual([]);
  });

  it("lets a clean direct push through", () => {
    expect(blockers()).toEqual([]);
  });

  it("reports validation errors against the Push tab", () => {
    const [blocker, ...rest] = blockers({
      plan: plan({ validationErrors: ["frame 0x100 has no signals", "bad scale"] }),
    });
    expect(rest).toEqual([]);
    expect(blocker.id).toBe("validation");
    expect(blocker.tab).toBe("push");
    expect(blocker.message).toContain("frame 0x100 has no signals; bad scale");
  });

  it("reports a pull request that would be opened against its own base", () => {
    const [blocker] = blockers({ openPr: true, effectiveBranch: "main" });
    expect(blocker.id).toBe("prBranch");
    expect(blocker.tab).toBe("branch");
  });

  it("clears the pull-request conflict once a different branch is named", () => {
    expect(blockers({ openPr: true, effectiveBranch: "catalog/sbrxxx" })).toEqual([]);
  });

  // The regression this shape exists to prevent: the old inline version rendered
  // `prNeedsItsOwnBranch ? … : validationErrors`, so an invalid catalogue with a
  // pull-request conflict showed only the conflict and the real errors vanished.
  it("reports every blocker at once, not just the first", () => {
    const found = blockers({
      plan: plan({
        validationErrors: ["bad scale"],
        secretFindings: [{ line: 4, label: "API key", excerpt: "key = …" }],
      }),
      openPr: true,
      effectiveBranch: "main",
    });
    expect(found.map((b) => b.id)).toEqual(["validation", "prBranch", "secrets"]);
  });

  it("drops the secrets blocker once they are acknowledged", () => {
    const withSecrets = plan({
      secretFindings: [{ line: 4, label: "API key", excerpt: "key = …" }],
    });
    expect(blockers({ plan: withSecrets }).map((b) => b.id)).toEqual(["secrets"]);
    expect(blockers({ plan: withSecrets, secretsAcknowledged: true })).toEqual([]);
  });

  describe("nothing to push", () => {
    it("is answered from the plan for a default direct push", () => {
      const [blocker] = blockers({ plan: plan({ localBlobSha: "same", baseBlobSha: "same" }) });
      expect(blocker.id).toBe("identical");
      expect(blocker.tone).toBe("warning");
      expect(blocker.message).toContain("main");
    });

    // Nothing in this dialog resolves it — the answer is to edit the catalogue — so
    // offering a jump would send the user somewhere that cannot help.
    it("offers no tab to jump to, because no tab can fix it", () => {
      const [blocker] = blockers({ plan: plan({ localBlobSha: "same", baseBlobSha: "same" }) });
      expect(blocker.tab).toBeUndefined();
    });

    // A file identical to `main` can be a genuine change against a feature branch, so
    // the base-branch comparison must not be reused for any other target.
    it("is not inferred from the base when another branch is the target", () => {
      expect(
        blockers({
          plan: plan({ localBlobSha: "same", baseBlobSha: "same" }),
          effectiveBranch: "v2-dev",
        }),
      ).toEqual([]);
    });

    it("defers to the loaded comparison, which knows the real target", () => {
      expect(
        blockers({
          plan: plan({ localBlobSha: "same", baseBlobSha: "same" }),
          diff: diff({ identical: false }),
        }),
      ).toEqual([]);

      const [blocker] = blockers({
        effectiveBranch: "v2-dev",
        diff: diff({ identical: true, comparedRef: "v2-dev" }),
      });
      expect(blocker.id).toBe("identical");
      expect(blocker.message).toContain("v2-dev");
    });

    it("does not fire for a file the push would create", () => {
      expect(blockers({ plan: plan({ baseBlobSha: null }) })).toEqual([]);
      expect(blockers({ diff: diff({ exists: false, identical: false }) })).toEqual(
        [],
      );
    });
  });
});
