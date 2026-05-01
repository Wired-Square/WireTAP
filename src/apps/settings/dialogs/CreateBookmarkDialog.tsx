// ui/src/apps/settings/dialogs/CreateBookmarkDialog.tsx

import { useTranslation } from "react-i18next";
import Dialog from "../../../components/Dialog";
import { Input, FormField, SecondaryButton, PrimaryButton } from "../../../components/forms";
import { h2, borderDefault } from "../../../styles";
import type { IOProfile } from "../stores/settingsStore";
import TimeBoundsInput, { type TimeBounds } from "../../../components/TimeBoundsInput";

type CreateBookmarkDialogProps = {
  isOpen: boolean;
  availableProfiles: IOProfile[];
  profileId: string;
  name: string;
  timeBounds: TimeBounds;
  onChangeProfileId: (id: string) => void;
  onChangeName: (name: string) => void;
  onChangeTimeBounds: (bounds: TimeBounds) => void;
  onCancel: () => void;
  onCreate: () => void;
};

export default function CreateBookmarkDialog({
  isOpen,
  availableProfiles,
  profileId,
  name,
  timeBounds,
  onChangeProfileId,
  onChangeName,
  onChangeTimeBounds,
  onCancel,
  onCreate,
}: CreateBookmarkDialogProps) {
  const { t } = useTranslation("settings");
  const isValid = profileId && name.trim() && timeBounds.startTime;

  return (
    <Dialog isOpen={isOpen} maxWidth="max-w-md">
      <div className="p-6">
        <h2 className={`${h2} mb-6`}>{t("dialogs.createBookmark.title")}</h2>

        <div className="space-y-4">
          <FormField label={t("dialogs.createBookmark.profile")} variant="default">
            <select
              value={profileId}
              onChange={(e) => onChangeProfileId(e.target.value)}
              className={`w-full px-3 py-2 text-sm rounded border ${borderDefault} bg-[var(--bg-surface)] text-[color:var(--text-primary)]`}
            >
              {availableProfiles.map((profile) => (
                <option key={profile.id} value={profile.id}>
                  {profile.name}
                </option>
              ))}
            </select>
          </FormField>

          <FormField label={t("dialogs.createBookmark.name")} variant="default">
            <Input
              variant="default"
              value={name}
              onChange={(e) => onChangeName(e.target.value)}
              placeholder={t("dialogs.createBookmark.namePlaceholder")}
            />
          </FormField>

          <TimeBoundsInput
            value={timeBounds}
            onChange={onChangeTimeBounds}
            showBookmarks={false}
          />
        </div>

        <div className="flex justify-end gap-3 mt-6">
          <SecondaryButton onClick={onCancel}>{t("common:actions.cancel")}</SecondaryButton>
          <PrimaryButton onClick={onCreate} disabled={!isValid}>
            {t("common:actions.create")}
          </PrimaryButton>
        </div>
      </div>
    </Dialog>
  );
}
