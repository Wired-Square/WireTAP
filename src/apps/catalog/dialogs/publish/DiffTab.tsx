// ui/src/apps/catalog/dialogs/publish/DiffTab.tsx
//
// What this push would actually change upstream.
//
// The rows arrive already computed — Rust holds both texts, so it runs the same LCS
// the editor's diff view uses rather than shipping the files here to be sent back.
// That is what makes this tab affordable: it costs a blob read, not a request.

import { History } from "lucide-react";
import * as ShareIcon from "../../../../components/catalogIcons";
import DiffView from "../../views/DiffView";
import { SecondaryButton } from "../../../../components/forms";
import { formatDisplayTime } from "../../../../utils/timeFormat";
import { iconMd, iconSm } from "../../../../styles/spacing";
import { borderDefault, caption, textDanger, textSecondary } from "../../../../styles";
import { badgeMetadataIcon } from "../../../../styles/badgeStyles";
import { PlanAlert, TabMessage, tabScroll } from "./parts";
import type { T } from "./types";
import type { PublishDiffResult } from "./usePublishDiff";

type Props = {
  t: T;
  state: PublishDiffResult;
  /** The branch the user asked for, which may not exist upstream yet. */
  requestedBranch: string;
};

export default function DiffTab({ t, state, requestedBranch }: Props) {
  const { diff, loading, error, reload } = state;

  // Only when there is nothing to show. Keeping the previous rows up while the next
  // comparison loads avoids tearing down and rebuilding the whole diff per keystroke.
  if (loading && !diff) {
    return (
      <TabMessage className={textSecondary}>
        <ShareIcon.Busy className={`${iconMd} animate-spin`} />
        {t("publish.diffLoading")}
      </TabMessage>
    );
  }

  if (error) {
    return (
      <div className={tabScroll}>
        <PlanAlert tone="danger">
          <p className={caption}>{t("publish.diffUnavailable")}</p>
          <p className={`${caption} ${textDanger}`}>{error}</p>
        </PlanAlert>
        <SecondaryButton onClick={reload}>{t("publish.diffRetry")}</SecondaryButton>
      </div>
    );
  }

  if (!diff) return <TabMessage>{t("publish.tabsNeedRepo")}</TabMessage>;

  return (
    <div className="flex-1 min-h-0 flex flex-col p-4 gap-2">
      <div className="flex items-center gap-2 flex-wrap">
        <span className={badgeMetadataIcon}>
          <ShareIcon.Branch className={iconSm} />
          {diff.comparedRef}
        </span>
        {!diff.exists && (
          <span className={badgeMetadataIcon}>
            <ShareIcon.NewCatalog className={iconSm} />
            {t("publish.diffNewFile")}
          </span>
        )}
        {diff.lastChange && (
          <span className={`${caption} inline-flex items-center gap-1`}>
            <History className={iconSm} />
            {t("publish.diffLastChange", {
              when: formatDisplayTime(diff.lastChange.timestamp),
              author: diff.lastChange.author,
              sha: diff.lastChange.sha,
            })}
          </span>
        )}
      </div>

      {/* A branch that is not upstream yet is compared against the base, because that
          is what the commit will be diffed against once it is pushed. */}
      {!diff.branchExists && requestedBranch.trim() && (
        <p className={caption}>
          {t("publish.diffBranchNew", { branch: requestedBranch.trim(), base: diff.comparedRef })}
        </p>
      )}

      {/* Pushing over an upstream change nobody pulled is the one genuinely risky
          thing this dialog can do, so it is said before the diff, not inside it. */}
      {diff.upstreamMoved && (
        <PlanAlert tone="warning">
          <p className={caption}>
            {t("publish.diffUpstreamMoved", { path: diff.targetPath, ref: diff.comparedRef })}
          </p>
        </PlanAlert>
      )}

      {/* An identical file has no rows — the backend skips the diff rather than
          producing a whole catalogue of unchanged context nothing would read. */}
      {diff.identical ? (
        <TabMessage className={`rounded-lg border ${borderDefault}`}>
          {t("publish.diffIdentical", { path: diff.targetPath, ref: diff.comparedRef })}
        </TabMessage>
      ) : (
        <>
          <p className={caption}>
            {diff.exists
              ? t("publish.diffLegend", { ref: diff.comparedRef })
              : t("publish.diffNoUpstream", { path: diff.targetPath, ref: diff.comparedRef })}
          </p>
          <div className={`flex-1 min-h-0 overflow-auto rounded-lg border ${borderDefault}`}>
            <DiffView lines={diff.lines} />
          </div>
        </>
      )}
    </div>
  );
}
