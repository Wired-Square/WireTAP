// ui/src/dialogs/ErrorDialog.tsx

import { AlertTriangle } from "lucide-react";
import { useTranslation } from "react-i18next";
import { iconXl } from "../styles/spacing";
import Dialog, { DialogBody, DialogFooter, DialogHeader, DialogTitle } from "../components/Dialog";
import { SecondaryButton } from "../components/forms/DialogButtons";
import { labelSmall, textSecondary, bgDanger, textDanger, roundedDefault, gapSmall } from "../styles";
import { Card } from "../components/Card";

export interface ErrorDialogProps {
  isOpen: boolean;
  title?: string;
  message: string;
  details?: string;
  onClose: () => void;
}

export default function ErrorDialog({
  isOpen,
  title,
  message,
  details,
  onClose,
}: ErrorDialogProps) {
  const { t } = useTranslation("dialogs");
  const headingTitle = title ?? t("error.defaultTitle");

  return (
    <Dialog isOpen={isOpen} size="xl" onClose={onClose}>
      <DialogHeader>
        <div className={`flex items-center ${gapSmall}`}>
          <div className={`w-12 h-12 ${bgDanger} ${roundedDefault} flex items-center justify-center`}>
            <AlertTriangle className={`${iconXl} ${textDanger}`} />
          </div>
          <DialogTitle>{headingTitle}</DialogTitle>
        </div>
      </DialogHeader>
      <DialogBody className="space-y-4">
        <p className={textSecondary}>{message}</p>

        {details && (
          <div>
            <div className={`${labelSmall} mb-2`}>{t("error.technicalDetails")}</div>
            <Card padding="lg">
              <pre className="text-xs text-[color:var(--text-primary)] font-mono whitespace-pre-wrap break-words">
                {details}
              </pre>
            </Card>
          </div>
        )}
      </DialogBody>
      <DialogFooter>
        <SecondaryButton onClick={onClose}>{t("common:actions.close")}</SecondaryButton>
      </DialogFooter>
    </Dialog>
  );
}
