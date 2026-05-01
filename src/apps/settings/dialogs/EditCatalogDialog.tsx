// ui/src/apps/settings/dialogs/EditCatalogDialog.tsx
import { useTranslation } from "react-i18next";
import Dialog from "../../../components/Dialog";
import { Input, FormField, PrimaryButton, SecondaryButton } from "../../../components/forms";
import { h2 } from "../../../styles";

type Props = {
  isOpen: boolean;
  name: string;
  filename: string;
  onChangeName: (value: string) => void;
  onChangeFilename: (value: string) => void;
  onCancel: () => void;
  onSave: () => void;
};

export default function EditCatalogDialog({
  isOpen,
  name,
  filename,
  onChangeName,
  onChangeFilename,
  onCancel,
  onSave,
}: Props) {
  const { t } = useTranslation("settings");

  return (
    <Dialog isOpen={isOpen} maxWidth="max-w-md">
      <div className="p-6">
        <h2 className={`${h2} mb-4`}>{t("dialogs.editCatalog.title")}</h2>

        <div className="space-y-4">
          <FormField label={t("dialogs.editCatalog.name")} variant="default">
            <Input
              variant="default"
              value={name}
              onChange={(e) => onChangeName(e.target.value)}
              placeholder={t("dialogs.editCatalog.namePlaceholder")}
            />
          </FormField>

          <FormField label={t("dialogs.editCatalog.filename")} variant="default">
            <Input
              variant="default"
              value={filename}
              onChange={(e) => onChangeFilename(e.target.value)}
              placeholder={t("dialogs.editCatalog.filenamePlaceholder")}
            />
          </FormField>
        </div>

        <div className="flex justify-end gap-3 mt-6">
          <SecondaryButton onClick={onCancel}>{t("common:actions.cancel")}</SecondaryButton>
          <PrimaryButton onClick={onSave}>{t("common:actions.save")}</PrimaryButton>
        </div>
      </div>
    </Dialog>
  );
}
