// ui/src/apps/settings/dialogs/CreateBookmarkDialog.tsx
import { useState, useEffect } from "react";
import Dialog from "../../../components/Dialog";
import { Input, FormField, SecondaryButton, PrimaryButton } from "../../../components/forms";
import { h2, borderDefault } from "../../../styles";
import type { IOProfile } from "../stores/settingsStore";
import { useSettingsStore } from "../stores/settingsStore";
import TimezoneBadge, {
  type TimezoneMode,
  convertDatetimeLocal,
} from "../../../components/TimezoneBadge";

type CreateBookmarkDialogProps = {
  isOpen: boolean;
  availableProfiles: IOProfile[];
  profileId: string;
  name: string;
  startTime: string;
  endTime: string;
  maxFrames: string;
  onChangeProfileId: (id: string) => void;
  onChangeName: (name: string) => void;
  onChangeStartTime: (time: string) => void;
  onChangeEndTime: (time: string) => void;
  onChangeMaxFrames: (maxFrames: string) => void;
  onCancel: () => void;
  onCreate: () => void;
};

export default function CreateBookmarkDialog({
  isOpen,
  availableProfiles,
  profileId,
  name,
  startTime,
  endTime,
  maxFrames,
  onChangeProfileId,
  onChangeName,
  onChangeStartTime,
  onChangeEndTime,
  onChangeMaxFrames,
  onCancel,
  onCreate,
}: CreateBookmarkDialogProps) {
  const [timezoneMode, setTimezoneMode] = useState<TimezoneMode>("default");
  const defaultTz = useSettingsStore((s) => s.display.timezone);

  // Reset timezone mode when dialog closes
  useEffect(() => {
    if (!isOpen) {
      setTimezoneMode("default");
    }
  }, [isOpen]);

  const handleTimezoneChange = (newMode: TimezoneMode) => {
    // Convert times to new timezone
    onChangeStartTime(convertDatetimeLocal(startTime, timezoneMode, newMode, defaultTz));
    onChangeEndTime(convertDatetimeLocal(endTime, timezoneMode, newMode, defaultTz));
    setTimezoneMode(newMode);
  };

  const isValid = profileId && name.trim() && startTime;

  return (
    <Dialog isOpen={isOpen} maxWidth="max-w-md">
      <div className="p-6">
        <h2 className={`${h2} mb-6`}>New Bookmark</h2>

        <div className="space-y-4">
          <FormField label="Profile" variant="default">
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

          <FormField label="Name" variant="default">
            <Input
              variant="default"
              value={name}
              onChange={(e) => onChangeName(e.target.value)}
              placeholder="Bookmark name"
            />
          </FormField>

          <FormField
            label={
              <span className="flex items-center gap-2">
                From
                <TimezoneBadge mode={timezoneMode} onChange={handleTimezoneChange} />
              </span>
            }
            variant="default"
          >
            <Input
              variant="default"
              type="datetime-local"
              step="1"
              value={startTime}
              onChange={(e) => onChangeStartTime(e.target.value)}
            />
          </FormField>

          <FormField label="To" variant="default">
            <Input
              variant="default"
              type="datetime-local"
              step="1"
              value={endTime}
              onChange={(e) => onChangeEndTime(e.target.value)}
            />
          </FormField>

          <FormField label="Max Frames" variant="default">
            <Input
              variant="default"
              type="number"
              min={0}
              placeholder="No limit"
              value={maxFrames}
              onChange={(e) => onChangeMaxFrames(e.target.value)}
            />
          </FormField>
        </div>

        <div className="flex justify-end gap-3 mt-6">
          <SecondaryButton onClick={onCancel}>Cancel</SecondaryButton>
          <PrimaryButton onClick={onCreate} disabled={!isValid}>
            Create
          </PrimaryButton>
        </div>
      </div>
    </Dialog>
  );
}
