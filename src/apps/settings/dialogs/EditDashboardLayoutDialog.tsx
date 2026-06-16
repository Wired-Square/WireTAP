// ui/src/apps/settings/dialogs/EditDashboardLayoutDialog.tsx

import { useTranslation } from "react-i18next";
import Dialog from "../../../components/Dialog";
import { Input, FormField, SecondaryButton, PrimaryButton } from "../../../components/forms";
import { h2 } from "../../../styles";

type EditDashboardLayoutDialogProps = {
  isOpen: boolean;
  name: string;
  onChangeName: (name: string) => void;
  onCancel: () => void;
  onSave: () => void;
};

export default function EditDashboardLayoutDialog({
  isOpen,
  name,
  onChangeName,
  onCancel,
  onSave,
}: EditDashboardLayoutDialogProps) {
  const { t } = useTranslation("settings");

  return (
    <Dialog isOpen={isOpen} maxWidth="max-w-md">
      <div className="p-6">
        <h2 className={`${h2} mb-6`}>{t("dialogs.editDashboardLayout.title")}</h2>

        <div className="space-y-4">
          <FormField label={t("dialogs.editDashboardLayout.name")} variant="default">
            <Input
              variant="default"
              value={name}
              onChange={(e) => onChangeName(e.target.value)}
              placeholder={t("dialogs.editDashboardLayout.namePlaceholder")}
            />
          </FormField>
        </div>

        <div className="flex justify-end gap-3 mt-6">
          <SecondaryButton onClick={onCancel}>{t("common:actions.cancel")}</SecondaryButton>
          <PrimaryButton onClick={onSave} disabled={!name.trim()}>
            {t("common:actions.save")}
          </PrimaryButton>
        </div>
      </div>
    </Dialog>
  );
}
