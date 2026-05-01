// ui/src/dialogs/TelemetryConsentDialog.tsx

import { Shield } from "lucide-react";
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

export interface TelemetryConsentDialogProps {
  isOpen: boolean;
  onAccept: () => void;
  onDecline: () => void;
}

export default function TelemetryConsentDialog({
  isOpen,
  onAccept,
  onDecline,
}: TelemetryConsentDialogProps) {
  const { t } = useTranslation("dialogs");

  return (
    <Dialog isOpen={isOpen}>
      <div className={paddingDialog}>
        {/* Header */}
        <div className={`flex items-center ${gapSmall} ${marginHeading}`}>
          <div className={`w-12 h-12 ${bgInfo} ${roundedDefault} flex items-center justify-center`}>
            <Shield className={`${iconXl} ${textInfo}`} />
          </div>
          <h2 className={h2}>{t("telemetryConsent.title")}</h2>
        </div>

        {/* Message */}
        <div className={`${textSecondary} space-y-3 mb-6`}>
          <p>{t("telemetryConsent.intro")}</p>
          <p>
            <Trans
              i18nKey="dialogs:telemetryConsent.details"
              components={{ strong: <strong /> }}
            />
          </p>
        </div>

        {/* Actions */}
        <div className={`flex justify-end ${gapSmall}`}>
          <SecondaryButton onClick={onDecline}>{t("telemetryConsent.decline")}</SecondaryButton>
          <PrimaryButton onClick={onAccept}>{t("telemetryConsent.accept")}</PrimaryButton>
        </div>
      </div>
    </Dialog>
  );
}
