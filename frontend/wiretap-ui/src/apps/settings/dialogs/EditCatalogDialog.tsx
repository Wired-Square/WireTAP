// ui/src/apps/settings/dialogs/EditCatalogDialog.tsx
import { useTranslation } from "react-i18next";
import Dialog, { DialogBody, DialogFooter } from "../../../components/Dialog";
import { Input, FormField, PrimaryButton, SecondaryButton } from "../../../components/forms";

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
    <Dialog isOpen={isOpen} onClose={onCancel} title={t("dialogs.editCatalog.title")}>
      <DialogBody className="space-y-4">
        <FormField label={t("dialogs.editCatalog.name")} variant="default">
          <Input
            size="lg"
            value={name}
            onChange={(e) => onChangeName(e.target.value)}
            placeholder={t("dialogs.editCatalog.namePlaceholder")}
          />
        </FormField>

        <FormField label={t("dialogs.editCatalog.filename")} variant="default">
          <Input
            size="lg"
            value={filename}
            onChange={(e) => onChangeFilename(e.target.value)}
            placeholder={t("dialogs.editCatalog.filenamePlaceholder")}
          />
        </FormField>
      </DialogBody>
      <DialogFooter>
        <SecondaryButton onClick={onCancel}>{t("common:actions.cancel")}</SecondaryButton>
        <PrimaryButton onClick={onSave}>{t("common:actions.save")}</PrimaryButton>
      </DialogFooter>
    </Dialog>
  );
}
