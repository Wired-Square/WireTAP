// ui/src/dialogs/AddBookmarkDialog.tsx

import { useState, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import Dialog, { DialogBody, DialogFooter } from "../components/Dialog";
import { SecondaryButton, PrimaryButton } from "../components/forms";
import Input from "../components/forms/Input";
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
    <Dialog isOpen={isOpen} title={t("addBookmark.title")}>
      <DialogBody className="space-y-4">
        <div className="space-y-3">
          {/* Name input */}
          <div className="space-y-1">
            <label className={labelSmall}>{t("addBookmark.name")}</label>
            <Input
              size="lg"
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
      </DialogBody>
      <DialogFooter>
        <SecondaryButton onClick={onClose}>{t("common:actions.cancel")}</SecondaryButton>
        <PrimaryButton onClick={handleSave} disabled={!name.trim() || !timeBounds.startTime}>{t("addBookmark.save")}</PrimaryButton>
      </DialogFooter>
    </Dialog>
  );
}
