// ui/src/apps/settings/dialogs/DuplicateCatalogDialog.tsx
import { useTranslation } from "react-i18next";
import Dialog, { DialogBody, DialogFooter } from "../../../components/Dialog";
import { Input, FormField, SecondaryButton, PrimaryButton } from "../../../components/forms";

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
    <Dialog isOpen={isOpen} onClose={onCancel} title={t("dialogs.duplicateCatalog.title")}>
      <DialogBody className="space-y-4">
        <FormField label={t("dialogs.duplicateCatalog.newName")} variant="default">
          <Input
            size="lg"
            value={name}
            onChange={(e) => onChangeName(e.target.value)}
            placeholder={t("dialogs.duplicateCatalog.namePlaceholder")}
          />
        </FormField>

        <FormField label={t("dialogs.duplicateCatalog.newFilename")} variant="default">
          <Input
            size="lg"
            value={filename}
            onChange={(e) => onChangeFilename(e.target.value)}
            placeholder={t("dialogs.duplicateCatalog.filenamePlaceholder")}
          />
        </FormField>
      </DialogBody>
      <DialogFooter>
        <SecondaryButton onClick={onCancel}>{t("common:actions.cancel")}</SecondaryButton>
        <PrimaryButton onClick={onDuplicate}>{t("common:actions.duplicate")}</PrimaryButton>
      </DialogFooter>
    </Dialog>
  );
}
