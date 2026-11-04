// ui/src/dialogs/ConfirmDeleteDialog.tsx

import { Trans, useTranslation } from "react-i18next";
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
  /** A full key whose sentence places the highlighted `name` with `<name>{{name}}</name>`. */
  messageKey?: string;
  name?: string;
  confirmText?: string;
  cancelText?: string;
};

export default function ConfirmDeleteDialog({
  open,
  onCancel,
  onConfirm,
  title,
  message,
  messageKey,
  name,
  confirmText,
  cancelText,
}: ConfirmDeleteDialogProps) {
  const { t } = useTranslation("dialogs");

  return (
    <Dialog isOpen={open} title={title ?? t("confirmDelete.defaultTitle")}>
      <DialogBody>
        <p className={bodyDefault}>
          {messageKey ? (
            <Trans
              i18nKey={messageKey}
              values={{ name: name ?? "" }}
              components={{ name: <span className={`font-semibold ${textDanger}`} /> }}
            />
          ) : (
            message ?? t("confirmDelete.defaultMessage")
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
