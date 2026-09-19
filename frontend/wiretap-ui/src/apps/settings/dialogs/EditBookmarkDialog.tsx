// ui/src/apps/settings/dialogs/EditBookmarkDialog.tsx

import { useTranslation } from "react-i18next";
import Dialog, { DialogBody, DialogFooter } from "../../../components/Dialog";
import { Input, FormField, SecondaryButton, PrimaryButton } from "../../../components/forms";
import TimeBoundsInput, { type TimeBounds } from "../../../components/TimeBoundsInput";

type EditBookmarkDialogProps = {
  isOpen: boolean;
  name: string;
  timeBounds: TimeBounds;
  onChangeName: (name: string) => void;
  onChangeTimeBounds: (bounds: TimeBounds) => void;
  onCancel: () => void;
  onSave: () => void;
};

export default function EditBookmarkDialog({
  isOpen,
  name,
  timeBounds,
  onChangeName,
  onChangeTimeBounds,
  onCancel,
  onSave,
}: EditBookmarkDialogProps) {
  const { t } = useTranslation("settings");

  return (
    <Dialog isOpen={isOpen} title={t("dialogs.editBookmark.title")}>
      <DialogBody className="space-y-4">
        <FormField label={t("dialogs.editBookmark.name")} variant="default">
          <Input
            size="lg"
            value={name}
            onChange={(e) => onChangeName(e.target.value)}
            placeholder={t("dialogs.editBookmark.namePlaceholder")}
          />
        </FormField>

        <TimeBoundsInput
          value={timeBounds}
          onChange={onChangeTimeBounds}
          showBookmarks={false}
        />
      </DialogBody>
      <DialogFooter>
        <SecondaryButton onClick={onCancel}>{t("common:actions.cancel")}</SecondaryButton>
        <PrimaryButton onClick={onSave} disabled={!name.trim()}>
          {t("common:actions.save")}
        </PrimaryButton>
      </DialogFooter>
    </Dialog>
  );
}
