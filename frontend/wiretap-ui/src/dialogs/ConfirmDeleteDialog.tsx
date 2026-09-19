// ui/src/dialogs/ConfirmDeleteDialog.tsx

import { useTranslation } from "react-i18next";
import Dialog, { DialogBody, DialogFooter } from '../components/Dialog';
import { SecondaryButton, DangerButton } from '../components/forms';
import { bodyDefault, textDanger } from '../styles';

export type ConfirmDeleteDialogProps = {
  open: boolean;
  onCancel: () => void;
  onConfirm: () => void;

  // Optional overrides
  title?: string;
  message?: string;
  highlightText?: string;
  confirmText?: string;
  cancelText?: string;
};

export default function ConfirmDeleteDialog({
  open,
  onCancel,
  onConfirm,
  title,
  message,
  highlightText,
  confirmText,
  cancelText,
}: ConfirmDeleteDialogProps) {
  const { t } = useTranslation("dialogs");

  return (
    <Dialog isOpen={open} title={title ?? t("confirmDelete.defaultTitle")}>
      <DialogBody>
        <p className={bodyDefault}>
          {message ?? t("confirmDelete.defaultMessage")}{" "}
          {highlightText && (
            <span className={`font-semibold ${textDanger}`}>{highlightText}</span>
          )}
        </p>
      </DialogBody>
      <DialogFooter>
        <SecondaryButton onClick={onCancel}>
          {cancelText ?? t("common:actions.cancel")}
        </SecondaryButton>
        <DangerButton onClick={onConfirm}>
          {confirmText ?? t("common:actions.delete")}
        </DangerButton>
      </DialogFooter>
    </Dialog>
  );
}
