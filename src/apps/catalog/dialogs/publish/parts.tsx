// ui/src/apps/catalog/dialogs/publish/parts.tsx
//
// The push dialog's small shared pieces, lifted out of the shell so the tabs and the
// persistent chrome can both reach them.

import type { ReactNode } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Globe, Lock } from "lucide-react";
import * as ShareIcon from "../../../../components/catalogIcons";
import { iconMd, iconSm } from "../../../../styles/spacing";
import {
  caption,
  cardCompact,
  emptyStateText,
  textDanger,
  textMedium,
  textSecondary,
  textSuccess,
  textWarning,
} from "../../../../styles";
import { alertDanger, alertWarning } from "../../../../styles/cardStyles";
import { badgeMetadata, badgeMetadataIcon } from "../../../../styles/badgeStyles";
import { CheckboxField } from "../../../../components/forms";
import type { PublishPlan, PublishStep, SecretFinding } from "../../../../api/catalogShare";
import type { Blocker, PublishTab, T } from "./types";

/** A tab body that scrolls its own content. The panel around it is a fixed-height
 *  flex column, so each body owns its scrolling rather than nesting inside one. */
export const tabScroll = "flex-1 min-h-0 overflow-y-auto p-4 space-y-3";

/** A tab body that is a single centred line — loading, empty, nothing to push. */
export function TabMessage({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`flex-1 min-h-0 flex items-center justify-center gap-2 px-4 text-center ${emptyStateText} ${className}`}
    >
      {children}
    </div>
  );
}

/** Box and glyph colours for an alert tone, so every alert shape agrees on them. */
const alertToneBox = (tone: Tone) => (tone === "danger" ? alertDanger : alertWarning);
const alertToneText = (tone: Tone) => (tone === "danger" ? textDanger : textWarning);

type Tone = Blocker["tone"];

export function PlanSummary({ plan, t }: { plan: PublishPlan; t: T }) {
  return (
    <div className={`${cardCompact} space-y-2`}>
      <div className="flex items-center gap-2 flex-wrap">
        <span className={textMedium}>{plan.upstream}</span>
        <span className={badgeMetadata}>{plan.baseBranch}</span>
        <span className={badgeMetadataIcon}>
          {plan.targetIsPublic ? <Globe className={iconSm} /> : <Lock className={iconSm} />}
          {plan.targetIsPublic ? t("publish.public") : t("publish.private")}
        </span>
        <span className={badgeMetadata}>
          {plan.forkNeeded ? t("publish.viaFork") : t("publish.directPush")}
        </span>
      </div>
      <p className={caption}>
        {t("publish.willCommit", { path: plan.targetPath, bytes: plan.contentBytes })}
      </p>
      {plan.transmitFrameCount > 0 && (
        <p className={caption}>
          <ShareIcon.TransmitRisk className={`${iconSm} inline`} />{" "}
          {t("publish.transmitFrames", { count: plan.transmitFrameCount })}
        </p>
      )}
      {plan.existingPrUrl && (
        <button
          onClick={() => void openUrl(plan.existingPrUrl!)}
          className={`${caption} underline hover:no-underline`}
        >
          {t("publish.existingPr")}
        </button>
      )}
    </div>
  );
}

export function SecretFindings({
  findings,
  acknowledged,
  onAcknowledge,
  t,
}: {
  findings: SecretFinding[];
  acknowledged: boolean;
  onAcknowledge: (checked: boolean) => void;
  t: T;
}) {
  return (
    <div className={`${alertDanger} space-y-2`}>
      <div className="flex items-start gap-2">
        <ShareIcon.Secret className={`${iconMd} ${textDanger} flex-shrink-0 mt-0.5`} />
        <div>
          <p className={textMedium}>{t("publish.secretsFound", { count: findings.length })}</p>
          <p className={caption}>{t("publish.secretsAdvice")}</p>
        </div>
      </div>
      <ul className="space-y-0.5">
        {findings.map((f) => (
          <li key={`${f.line}-${f.label}`} className={caption}>
            {t("publish.secretLine", { line: f.line, label: f.label })}: <code>{f.excerpt}</code>
          </li>
        ))}
      </ul>
      <CheckboxField
        checked={acknowledged}
        onChange={onAcknowledge}
        label={t("publish.secretsAcknowledge")}
      />
    </div>
  );
}

/**
 * The dialog's alert row. Re-exported rather than redefined: it moved to
 * `components/Alert` when five other catalogue dialogs turned out to be hand-rolling
 * the same markup, and the tab files import it from here.
 */
export { default as PlanAlert } from "../../../../components/Alert";

/**
 * Every reason Push is off, in the persistent chrome beside the button it disables.
 *
 * Not inside a tab: a tab can hide the control that caused the blocker, so a blocker
 * rendered in one would be invisible from exactly the tab you were standing on. One
 * box with a row each — aggregate tone on the box, per-row tone on the glyph — rather
 * than a stack of boxes, so three blockers do not become three borders.
 */
export function BlockerStrip({
  blockers,
  activeTab,
  onOpenTab,
  t,
}: {
  blockers: Blocker[];
  activeTab: PublishTab;
  onOpenTab: (tab: PublishTab) => void;
  t: T;
}) {
  const tone: Tone = blockers.some((b) => b.tone === "danger") ? "danger" : "warning";
  return (
    <div className={`mx-4 mb-2 space-y-1.5 ${alertToneBox(tone)}`}>
      {blockers.map((blocker) => (
        <div key={blocker.id} className="flex items-start gap-2">
          <ShareIcon.Alert
            className={`${iconMd} flex-shrink-0 mt-0.5 ${alertToneText(blocker.tone)}`}
          />
          <p className={`${caption} flex-1`}>{blocker.message}</p>
          {blocker.tab && blocker.tab !== activeTab && (
            <button
              onClick={() => onOpenTab(blocker.tab!)}
              className={`${caption} underline hover:no-underline flex-shrink-0`}
            >
              {t("publish.fixOnTab", { tab: t(`publish.tabs.${blocker.tab}`) })}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

export function StepChecklist({
  steps,
  expected,
  currentStep,
  detail,
  t,
}: {
  steps: PublishStep[];
  expected: PublishStep[];
  currentStep: PublishStep | null;
  detail: string | null;
  t: T;
}) {
  // Emitted steps are not a prefix of STEP_ORDER — `fork` only happens without push
  // access, `branch` only when one is named, `pr` only when asked for — so completion
  // is read from what actually arrived rather than inferred from position.
  const seen = new Set(steps);
  return (
    <div className={`${cardCompact} space-y-1`}>
      {expected.map((step) => {
        const active = currentStep === step;
        const done = seen.has(step) && !active;
        return (
          <div key={step} className="flex items-center gap-2">
            {done ? (
              <ShareIcon.Success className={`${iconSm} ${textSuccess}`} />
            ) : active ? (
              <ShareIcon.Busy className={`${iconSm} ${textSecondary} animate-spin`} />
            ) : (
              <div className={`${iconSm} rounded-full border border-current opacity-30`} />
            )}
            <span className={caption}>{t(`publish.step.${step}`)}</span>
            {active && detail && <span className={caption}>— {detail}</span>}
          </div>
        );
      })}
    </div>
  );
}
