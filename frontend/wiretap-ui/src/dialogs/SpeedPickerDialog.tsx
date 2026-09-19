// ui/src/dialogs/SpeedPickerDialog.tsx

import { Check } from "lucide-react";
import { useTranslation } from "react-i18next";
import { iconMd } from "../styles/spacing";
import Dialog, { DialogBody } from "../components/Dialog";
import type { PlaybackSpeed } from "../components/TimeController";
import { hoverLight, textSuccess, textMedium } from "../styles";
import { SPEED_OPTIONS } from "./io-source-picker/utils";

type Props = {
  isOpen: boolean;
  onClose: () => void;
  speed: PlaybackSpeed;
  onSpeedChange: (speed: PlaybackSpeed) => void;
};

export default function SpeedPickerDialog({
  isOpen,
  onClose,
  speed,
  onSpeedChange,
}: Props) {
  const { t } = useTranslation("dialogs");
  const handleSelect = (newSpeed: PlaybackSpeed) => {
    onSpeedChange(newSpeed);
    onClose();
  };

  return (
    <Dialog isOpen={isOpen} onClose={onClose} size="sm" title={t("speedPicker.title")}>
      <DialogBody padding="none" className="max-h-[50vh]">
        <div className="py-1">
          {SPEED_OPTIONS.map((opt) => {
            const isSelected = opt.value === speed;
            return (
              <button
                key={opt.value}
                onClick={() => handleSelect(opt.value)}
                className={`w-full px-4 py-2.5 flex items-center gap-3 text-left ${hoverLight} transition-colors ${
                  isSelected ? "bg-[var(--hover-bg)]" : ""
                }`}
              >
                <span className={`flex-1 ${textMedium}`}>
                  {opt.label}
                </span>
                {isSelected && (
                  <Check className={`${iconMd} ${textSuccess} flex-shrink-0`} />
                )}
              </button>
            );
          })}
        </div>
      </DialogBody>
    </Dialog>
  );
}
