// ui/src/apps/catalog/dialogs/publish/publishTabs.tsx
//
// What the tab strip shows: which tab carries a dot, and what the Changes tab counts.
//
// Pure and derived, like publishBlockers beside it — the shell renders the strip, it
// does not need to be where the strip's appearance is worked out.

import * as ShareIcon from "../../../../components/catalogIcons";
import type { TabDef } from "../../../../components/TabStrip";
import type { PublishPlan } from "../../../../api/catalogShare";
import { iconSm } from "../../../../styles/spacing";
import type { Blocker, PublishTab, T } from "./types";
import type { PublishDiffResult } from "./usePublishDiff";

export function publishTabs({
  t,
  plan,
  blockers,
  diff,
}: {
  t: T;
  plan: PublishPlan | null;
  blockers: Blocker[];
  diff: PublishDiffResult;
}): TabDef<PublishTab>[] {
  // The caller already knows which tab it is describing, so the warning condition
  // comes in rather than being looked up from the id. A blocker's own tone wins: a
  // warning that happens to stop the push should not paint the tab as an error.
  const tone = (id: PublishTab, warn?: boolean): TabDef<PublishTab>["tone"] => {
    const owned = blockers.filter((b) => b.tab === id);
    if (owned.some((b) => b.tone === "danger")) return "danger";
    return owned.length > 0 || warn ? "warning" : undefined;
  };
  // Both of these need a plan to render anything at all, and saying why is cheaper
  // than letting someone click into an empty panel.
  const needsPlan = plan ? {} : { disabledReason: t("publish.tabsNeedRepo") };

  return [
    {
      id: "push",
      label: t("publish.tabs.push"),
      icon: <ShareIcon.Push className={iconSm} />,
      tone: tone("push", plan?.targetIsPublic),
    },
    {
      id: "branch",
      label: t("publish.tabs.branch"),
      icon: <ShareIcon.Branch className={iconSm} />,
      tone: tone("branch", plan?.forkNeeded),
      ...needsPlan,
    },
    {
      id: "diff",
      label: t("publish.tabs.diff"),
      icon: <ShareIcon.Diff className={iconSm} />,
      tone: tone("diff"),
      badge: diffBadge(diff, t),
      ...needsPlan,
    },
  ];
}

/** `+12 −3`, `New file` or `No change` — nothing while it is still loading. */
function diffBadge({ diff, loading }: PublishDiffResult, t: T): string | undefined {
  if (!diff || loading) return undefined;
  if (!diff.exists) return t("publish.diffNewFile");
  if (diff.identical) return t("publish.diffNoChange");
  return t("publish.diffStats", { added: diff.added, removed: diff.removed });
}
