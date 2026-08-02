// ui/src/apps/catalog/dialogs/publish/PushTab.tsx
//
// What is being pushed and what that repository is like.
//
// The blocking alerts deliberately do not live here — they are in the dialog's
// persistent strip, beside the button they disable. What stays is the non-blocking
// context (fork, exposure) and the secret findings, which are a list to read rather
// than a one-line reason.

import { caption } from "../../../../styles";
import { CheckboxField } from "../../../../components/forms";
import type { PublishPlan } from "../../../../api/catalogShare";
import { PlanAlert, PlanSummary, SecretFindings, TabMessage, tabScroll } from "./parts";
import type { T } from "./types";

type Props = {
  t: T;
  plan: PublishPlan | null;
  secretsAcknowledged: boolean;
  onAcknowledgeSecrets: (checked: boolean) => void;
  /** Whether this push will actually bump — already false when the editor is dirty. */
  bumpVersion: boolean;
  onBumpVersion: (checked: boolean) => void;
  /**
   * Set when the Catalog editor holds this catalogue with unsaved changes, which
   * disables the bump. Publishing sends the *saved* bytes, so bumping would put a new
   * version on disk that the editor's next save writes straight back over.
   */
  editorIsDirty: boolean;
};

export default function PushTab({
  t,
  plan,
  secretsAcknowledged,
  onAcknowledgeSecrets,
  bumpVersion,
  onBumpVersion,
  editorIsDirty,
}: Props) {
  if (!plan) return <TabMessage>{t("publish.tabsNeedRepo")}</TabMessage>;

  return (
    <div className={tabScroll}>
      {plan.forkNeeded && (
        <PlanAlert tone="warning">
          <p className={caption}>{t("publish.noPushAccess", { repo: plan.upstream })}</p>
        </PlanAlert>
      )}

      <PlanSummary plan={plan} t={t} />

      {/* Under the summary, because this changes *what is committed* rather than where
          it lands — which is what separates it from the Branch tab's controls. */}
      <CheckboxField
        checked={bumpVersion}
        disabled={editorIsDirty}
        onChange={onBumpVersion}
        label={
          editorIsDirty
            ? t("publish.bumpVersionDirty")
            : t("publish.bumpVersion", { from: plan.metaVersion, to: plan.metaVersion + 1 })
        }
      />

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
