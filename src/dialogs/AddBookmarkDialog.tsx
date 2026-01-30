// ui/src/dialogs/AddBookmarkDialog.tsx

import { useState, useEffect } from "react";
import Dialog from "../components/Dialog";
import Input from "../components/forms/Input";
import { DialogFooter } from "../components/forms/DialogFooter";
import { labelSmall, helpText } from "../styles";
import { useSettingsStore } from "../apps/settings/stores/settingsStore";
import TimezoneBadge, {
  type TimezoneMode,
  convertDatetimeLocal,
} from "../components/TimezoneBadge";

type Props = {
  isOpen: boolean;
  frameId: number;
  frameTime: string; // datetime-local format
  onClose: () => void;
  onSave: (name: string, startTime: string, endTime: string) => void;
};

export default function AddBookmarkDialog({
  isOpen,
  frameId,
  frameTime,
  onClose,
  onSave,
}: Props) {
  const [name, setName] = useState("");
  const [startTime, setStartTime] = useState("");
  const [endTime, setEndTime] = useState("");
  const [timezoneMode, setTimezoneMode] = useState<TimezoneMode>("default");
  const defaultTz = useSettingsStore((s) => s.display.timezone);

  // Reset form when dialog opens with new frame
  useEffect(() => {
    if (isOpen) {
      setName(`Frame 0x${frameId.toString(16).toUpperCase()}`);
      setStartTime(frameTime);
      setEndTime("");
      setTimezoneMode("default");
    }
  }, [isOpen, frameId, frameTime]);

  const handleTimezoneChange = (newMode: TimezoneMode) => {
    // Convert times to new timezone
    setStartTime(convertDatetimeLocal(startTime, timezoneMode, newMode, defaultTz));
    setEndTime(convertDatetimeLocal(endTime, timezoneMode, newMode, defaultTz));
    setTimezoneMode(newMode);
  };

  const handleSave = () => {
    if (!name.trim() || !startTime) return;
    onSave(name.trim(), startTime, endTime);
    onClose();
  };

  return (
    <Dialog isOpen={isOpen} maxWidth="max-w-md">
      <div className="p-6 space-y-4">
        <h2 className="text-lg font-semibold text-[color:var(--text-primary)]">
          Add Bookmark
        </h2>

        <div className="space-y-3">
          {/* Name input */}
          <div className="space-y-1">
            <label className={labelSmall}>Name</label>
            <Input
              variant="simple"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Bookmark name"
            />
          </div>

          {/* From time */}
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <label className={labelSmall}>From</label>
              <TimezoneBadge mode={timezoneMode} onChange={handleTimezoneChange} />
            </div>
            <Input
              variant="simple"
              type="datetime-local"
              step="1"
              value={startTime}
              onChange={(e) => setStartTime(e.target.value)}
            />
          </div>

          {/* To time (optional) */}
          <div className="space-y-1">
            <label className={labelSmall}>To (optional)</label>
            <Input
              variant="simple"
              type="datetime-local"
              step="1"
              value={endTime}
              onChange={(e) => setEndTime(e.target.value)}
              min={startTime}
            />
            <p className={helpText}>
              Leave empty to bookmark just the start time
            </p>
          </div>
        </div>

        <DialogFooter
          onCancel={onClose}
          onConfirm={handleSave}
          confirmLabel="Save Bookmark"
          confirmDisabled={!name.trim() || !startTime}
        />
      </div>
    </Dialog>
  );
}
