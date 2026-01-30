// ui/src/dialogs/ErrorDialog.tsx

import { AlertTriangle, X } from "lucide-react";
import { iconLg, iconXl } from "../styles/spacing";
import Dialog from "../components/Dialog";
import { SecondaryButton } from "../components/forms/DialogButtons";
import {
  detailBox,
  labelSmall,
  h2,
  textSecondary,
  bgDanger,
  textDanger,
  paddingDialog,
  marginHeading,
  roundedDefault,
  gapSmall,
} from "../styles";

export interface ErrorDialogProps {
  isOpen: boolean;
  title?: string;
  message: string;
  details?: string;
  onClose: () => void;
}

export default function ErrorDialog({
  isOpen,
  title = "Error",
  message,
  details,
  onClose,
}: ErrorDialogProps) {
  return (
    <Dialog isOpen={isOpen} maxWidth="max-w-2xl">
      <div className={paddingDialog}>
        {/* Header */}
        <div className={`flex items-start justify-between ${marginHeading}`}>
          <div className={`flex items-center ${gapSmall}`}>
            <div className={`w-12 h-12 ${bgDanger} ${roundedDefault} flex items-center justify-center`}>
              <AlertTriangle className={`${iconXl} ${textDanger}`} />
            </div>
            <div>
              <h2 className={h2}>{title}</h2>
            </div>
          </div>
          <button
            onClick={onClose}
            className="text-[color:var(--text-muted)] hover:text-[color:var(--text-secondary)] transition-colors"
          >
            <X className={iconLg} />
          </button>
        </div>

        {/* Message */}
        <div className={marginHeading}>
          <p className={textSecondary}>{message}</p>
        </div>

        {/* Details (if provided) */}
        {details && (
          <div className="mb-4">
            <div className={`${labelSmall} mb-2`}>Technical Details:</div>
            <div className={detailBox}>
              <pre className="text-xs text-[color:var(--text-primary)] font-mono whitespace-pre-wrap break-words">
                {details}
              </pre>
            </div>
          </div>
        )}

        {/* Actions */}
        <div className={`flex justify-end ${gapSmall}`}>
          <SecondaryButton onClick={onClose}>Close</SecondaryButton>
        </div>
      </div>
    </Dialog>
  );
}
