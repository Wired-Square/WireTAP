// ui/src/apps/settings/dialogs/DuplicateCatalogDialog.tsx
import { useTranslation } from "react-i18next";
import Dialog from "../../../components/Dialog";
import { Input, FormField, SecondaryButton, PrimaryButton } from "../../../components/forms";
import { h2 } from "../../../styles";

type Props = {
  isOpen: boolean;
  name: string;
  filename: string;
  onChangeName: (value: string) => void;
  onChangeFilename: (value: string) => void;
  onCancel: () => void;
  onDuplicate: () => void;
};

export default function DuplicateCatalogDialog({
  isOpen,
  name,
  filename,
  onChangeName,
  onChangeFilename,
  onCancel,
  onDuplicate,
}: Props) {
  const { t } = useTranslation("settings");

  return (
    <Dialog isOpen={isOpen} maxWidth="max-w-md">
      <div className="p-6">
        <h2 className={`${h2} mb-6`}>{t("dialogs.duplicateCatalog.title")}</h2>

        <div className="space-y-4">
          <FormField label={t("dialogs.duplicateCatalog.newName")} variant="default">
            <Input
              variant="default"
              value={name}
              onChange={(e) => onChangeName(e.target.value)}
              placeholder={t("dialogs.duplicateCatalog.namePlaceholder")}
            />
          </FormField>

          <FormField label={t("dialogs.duplicateCatalog.newFilename")} variant="default">
            <Input
              variant="default"
              value={filename}
              onChange={(e) => onChangeFilename(e.target.value)}
              placeholder={t("dialogs.duplicateCatalog.filenamePlaceholder")}
            />
          </FormField>
        </div>

        <div className="flex justify-end gap-3 mt-6">
          <SecondaryButton onClick={onCancel}>{t("common:actions.cancel")}</SecondaryButton>
          <PrimaryButton onClick={onDuplicate}>{t("common:actions.duplicate")}</PrimaryButton>
        </div>
      </div>
    </Dialog>
  );
}
