// ui/src/apps/catalog/dialogs/publish/publishBlockers.ts
//
// Why the Push button is off, as data.
//
// Pure and separate from the dialog because the answer is the dialog's one piece of
// real logic, and because the previous inline version had a bug this shape cannot
// have: it rendered `prNeedsItsOwnBranch ? … : validationErrors`, so an invalid
// catalogue *and* a pull-request conflict showed only the conflict.

import type { PublishDiff, PublishPlan } from "../../../../api/catalogShare";
import type { Blocker } from "./types";

type Translate = (key: string, options?: Record<string, unknown>) => string;

type BlockerInput = {
  plan: PublishPlan | null;
  openPr: boolean;
  /** The branch that will actually be committed to, derived by the dialog. */
  effectiveBranch: string;
  /** The path that will actually be committed to, after any override. */
  effectivePath: string;
  secretsAcknowledged: boolean;
  /** The loaded comparison, when the Changes tab has been opened. */
  diff: PublishDiff | null;
  t: Translate;
};

/**
 * Every reason this push cannot proceed, most structural first.
 *
 * Empty means Push is live. Nothing here consults the in-flight state — that is the
 * dialog's business, not a reason the request is invalid.
 */
export function publishBlockers({
  plan,
  openPr,
  effectiveBranch,
  effectivePath,
  secretsAcknowledged,
  diff,
  t,
}: BlockerInput): Blocker[] {
  // No plan yet means nothing has been checked, so there is nothing to report. The
  // dialog disables Push on its own until preflight has answered.
  if (!plan) return [];

  const blockers: Blocker[] = [];

  if (plan.validationErrors.length > 0) {
    blockers.push({
      id: "validation",
      tab: "push",
      tone: "danger",
      message: `${t("publish.invalid")}: ${plan.validationErrors.join("; ")}`,
    });
  }

  // Checked here rather than read off the plan: the conflict depends on the pull
  // request toggle, and the plan is deliberately not re-fetched when a checkbox
  // moves. The backend enforces the same rule — this only moves the message earlier.
  if (openPr && effectiveBranch === plan.baseBranch) {
    blockers.push({
      id: "prBranch",
      tab: "branch",
      tone: "danger",
      message: t("publish.prNeedsBranch", { branch: plan.baseBranch }),
    });
  }

  if (plan.secretFindings.length > 0 && !secretsAcknowledged) {
    blockers.push({
      id: "secrets",
      tab: "push",
      tone: "danger",
      message: t("publish.secretsBlocked", { count: plan.secretFindings.length }),
    });
  }

  // Two sources, because the plan is a function of the repository and the diff is a
  // function of the branch. The plan can answer immediately, but only for the default
  // direct push; anything else has to wait for the Changes tab to have been opened.
  // Never infer one from the other: a file identical to `main` can be a real change
  // against an existing feature branch.
  const identicalRef = identicalTo(plan, diff, effectiveBranch);
  if (identicalRef) {
    blockers.push({
      // No `tab`: the Changes tab shows the same verdict but has no control that
      // resolves it — the answer is to edit the catalogue, which lives elsewhere.
      id: "identical",
      tone: "warning",
      message: t("publish.diffIdentical", { path: effectivePath, ref: identicalRef }),
    });
  }

  return blockers;
}

/** The ref the local bytes are already identical to, or null when they differ. */
function identicalTo(
  plan: PublishPlan,
  diff: PublishDiff | null,
  effectiveBranch: string,
): string | null {
  // The loaded comparison wins: it was made against the ref actually chosen.
  if (diff) return diff.identical ? diff.comparedRef : null;
  const isDefaultPush = effectiveBranch === plan.baseBranch;
  return isDefaultPush && plan.localBlobSha === plan.baseBlobSha ? plan.baseBranch : null;
}
