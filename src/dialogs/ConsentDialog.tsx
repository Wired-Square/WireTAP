// ui/src/dialogs/ConsentDialog.tsx
//
// Shared first-run consent dialog. Parameterised by an icon and an i18n key
// prefix (in the "dialogs" namespace) so each consent category — crash reports,
// usage analytics, … — is a one-line render rather than a duplicated file.

import type { LucideIcon } from "lucide-react";
import { Trans, useTranslation } from "react-i18next";
import { iconXl } from "../styles/spacing";
import Dialog from "../components/Dialog";
import { PrimaryButton, SecondaryButton } from "../components/forms/DialogButtons";
import {
  h2,
  textSecondary,
  bgInfo,
  textInfo,
  paddingDialog,
  marginHeading,
  roundedDefault,
  gapSmall,
} from "../styles";

export interface ConsentDialogProps {
  isOpen: boolean;
  onAccept: () => void;
  onDecline: () => void;
  icon: LucideIcon;
  /** Key prefix in the "dialogs" i18n namespace, e.g. "telemetryConsent". */
  i18nKey: string;
}

export default function ConsentDialog({
  isOpen,
  onAccept,
  onDecline,
  icon: Icon,
  i18nKey,
}: ConsentDialogProps) {
  const { t } = useTranslation("dialogs");

  return (
    <Dialog isOpen={isOpen}>
      <div className={paddingDialog}>
        {/* Header */}
        <div className={`flex items-center ${gapSmall} ${marginHeading}`}>
          <div className={`w-12 h-12 ${bgInfo} ${roundedDefault} flex items-center justify-center`}>
            <Icon className={`${iconXl} ${textInfo}`} />
          </div>
          <h2 className={h2}>{t(`${i18nKey}.title`)}</h2>
        </div>

        {/* Message */}
        <div className={`${textSecondary} space-y-3 mb-6`}>
          <p>{t(`${i18nKey}.intro`)}</p>
          <p>
            <Trans i18nKey={`dialogs:${i18nKey}.details`} components={{ strong: <strong /> }} />
          </p>
        </div>

        {/* Actions */}
        <div className={`flex justify-end ${gapSmall}`}>
          <SecondaryButton onClick={onDecline}>{t(`${i18nKey}.decline`)}</SecondaryButton>
          <PrimaryButton onClick={onAccept}>{t(`${i18nKey}.accept`)}</PrimaryButton>
        </div>
      </div>
    </Dialog>
  );
}
