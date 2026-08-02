// ui/src/apps/catalog/dialogs/publish/PushTab.tsx
//
// What is being pushed and what that repository is like.
//
// The blocking alerts deliberately do not live here — they are in the dialog's
// persistent strip, beside the button they disable. What stays is the non-blocking
// context (fork, exposure) and the secret findings, which are a list to read rather
// than a one-line reason.

import { caption } from "../../../../styles";
import type { PublishPlan } from "../../../../api/catalogShare";
import { PlanAlert, PlanSummary, SecretFindings, TabMessage, tabScroll } from "./parts";
import type { T } from "./types";

type Props = {
  t: T;
  plan: PublishPlan | null;
  secretsAcknowledged: boolean;
  onAcknowledgeSecrets: (checked: boolean) => void;
};

export default function PushTab({ t, plan, secretsAcknowledged, onAcknowledgeSecrets }: Props) {
  if (!plan) return <TabMessage>{t("publish.tabsNeedRepo")}</TabMessage>;

  return (
    <div className={tabScroll}>
      {plan.forkNeeded && (
        <PlanAlert tone="warning">
          <p className={caption}>{t("publish.noPushAccess", { repo: plan.upstream })}</p>
        </PlanAlert>
      )}

      <PlanSummary plan={plan} t={t} />

      {plan.targetIsPublic && (
        <PlanAlert tone="warning">
          <p className={caption}>{t("publish.publicWarning")}</p>
        </PlanAlert>
      )}

      {plan.secretFindings.length > 0 && (
        <SecretFindings
          findings={plan.secretFindings}
          acknowledged={secretsAcknowledged}
          onAcknowledge={onAcknowledgeSecrets}
          t={t}
        />
      )}
    </div>
  );
}
