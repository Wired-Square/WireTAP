// ui/src/dialogs/UnsavedChangesDialog.tsx

import { useTranslation } from "react-i18next";
import Dialog from '../components/Dialog';
import { SecondaryButton, DangerButton } from '../components/forms';
import { h2, bodyDefault, paddingDialog, gapDefault } from '../styles';

export type UnsavedChangesDialogProps = {
  isOpen: boolean;
  onCancel: () => void;
  onConfirmLeave: () => void;
};

/**
 * Dialog to confirm leaving a screen with unsaved changes.
 * Shared across Settings and Catalog Editor.
 */
export default function UnsavedChangesDialog({ isOpen, onCancel, onConfirmLeave }: UnsavedChangesDialogProps) {
  const { t } = useTranslation("dialogs");

  return (
    <Dialog isOpen={isOpen}>
      <div className={paddingDialog}>
        <h2 className={`${h2} mb-4`}>{t("unsavedChanges.title")}</h2>
        <p className={`${bodyDefault} mb-6`}>{t("unsavedChanges.message")}</p>
        <div className={`flex justify-end ${gapDefault}`}>
          <SecondaryButton onClick={onCancel}>{t("common:actions.cancel")}</SecondaryButton>
          <DangerButton onClick={onConfirmLeave}>{t("unsavedChanges.leaveWithoutSaving")}</DangerButton>
        </div>
      </div>
    </Dialog>
  );
}
