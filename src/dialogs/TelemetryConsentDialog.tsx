// ui/src/dialogs/TelemetryConsentDialog.tsx

import { Shield } from "lucide-react";
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
  return (
    <Dialog isOpen={isOpen}>
      <div className={paddingDialog}>
        {/* Header */}
        <div className={`flex items-center ${gapSmall} ${marginHeading}`}>
          <div className={`w-12 h-12 ${bgInfo} ${roundedDefault} flex items-center justify-center`}>
            <Shield className={`${iconXl} ${textInfo}`} />
          </div>
          <h2 className={h2}>Help improve CANdor</h2>
        </div>

        {/* Message */}
        <div className={`${textSecondary} space-y-3 mb-6`}>
          <p>
            Hey! I'm building CANdor mostly on my own, and when something breaks
            in the field I often have no idea what happened. If you're happy to
            share anonymous crash reports it'd be a huge help — it means I can
            find and fix problems faster, even the ones nobody thinks to report.
          </p>
          <p>
            No personal data, no CAN bus data, no usage tracking — just error
            stack traces so I know what blew up and where. You can change your
            mind any time in <strong>Settings → Privacy</strong>.
          </p>
        </div>

        {/* Actions */}
        <div className={`flex justify-end ${gapSmall}`}>
          <SecondaryButton onClick={onDecline}>No thanks</SecondaryButton>
          <PrimaryButton onClick={onAccept}>Yes, help improve CANdor</PrimaryButton>
        </div>
      </div>
    </Dialog>
  );
}
