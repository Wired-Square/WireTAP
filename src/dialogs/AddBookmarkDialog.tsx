// ui/src/dialogs/AddBookmarkDialog.tsx

import { useState, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import Dialog from "../components/Dialog";
import Input from "../components/forms/Input";
import { DialogFooter } from "../components/forms/DialogFooter";
import { labelSmall } from "../styles";
import TimeBoundsInput, { type TimeBounds } from "../components/TimeBoundsInput";

type Props = {
  isOpen: boolean;
  frameId: number;
  frameTime: string; // datetime-local format
  onClose: () => void;
  onSave: (name: string, startTime: string, endTime: string, maxFrames?: number) => void;
};

export default function AddBookmarkDialog({
  isOpen,
  frameId,
  frameTime,
  onClose,
  onSave,
}: Props) {
  const { t } = useTranslation("dialogs");
  const [name, setName] = useState("");
  const [timeBounds, setTimeBounds] = useState<TimeBounds>({
    startTime: "",
    endTime: "",
    maxFrames: undefined,
    timezoneMode: "local",
  });

  // Reset form when dialog opens with new frame
  useEffect(() => {
    if (isOpen) {
      setName(t("addBookmark.defaultName", { frameId: `0x${frameId.toString(16).toUpperCase()}` }));
      setTimeBounds({
        startTime: frameTime,
        endTime: "",
        maxFrames: undefined,
        timezoneMode: "local",
      });
    }
  }, [isOpen, frameId, frameTime, t]);

  const handleTimeBoundsChange = useCallback((bounds: TimeBounds) => {
    setTimeBounds(bounds);
  }, []);

  const handleSave = () => {
    if (!name.trim() || !timeBounds.startTime) return;
    onSave(name.trim(), timeBounds.startTime, timeBounds.endTime, timeBounds.maxFrames);
    onClose();
  };

  return (
    <Dialog isOpen={isOpen} maxWidth="max-w-md">
      <div className="p-6 space-y-4">
        <h2 className="text-lg font-semibold text-[color:var(--text-primary)]">
          {t("addBookmark.title")}
        </h2>

        <div className="space-y-3">
          {/* Name input */}
          <div className="space-y-1">
            <label className={labelSmall}>{t("addBookmark.name")}</label>
            <Input
              variant="simple"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t("addBookmark.namePlaceholder")}
            />
          </div>

          {/* Time bounds */}
          <TimeBoundsInput
            value={timeBounds}
            onChange={handleTimeBoundsChange}
            showBookmarks={false}
          />
        </div>

        <DialogFooter
          onCancel={onClose}
          onConfirm={handleSave}
          confirmLabel={t("addBookmark.save")}
          confirmDisabled={!name.trim() || !timeBounds.startTime}
        />
      </div>
    </Dialog>
  );
}
