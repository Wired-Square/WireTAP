// ui/src/dialogs/SpeedPickerDialog.tsx

import { Check } from "lucide-react";
import { useTranslation } from "react-i18next";
import { iconMd } from "../styles/spacing";
import Dialog, { DialogBody } from "../components/Dialog";
import type { PlaybackSpeed } from "../components/TimeController";
import { textSuccess, textMedium } from "../styles";
import { Listbox, Option } from "../components/Listbox";
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
        <Listbox variant="flush">
          {SPEED_OPTIONS.map((opt) => {
            const isSelected = opt.value === speed;
            return (
              <Option key={opt.value} selected={isSelected} onClick={() => handleSelect(opt.value)}>
                <span className={`flex-1 ${textMedium}`}>
                  {opt.label}
                </span>
                {isSelected && (
                  <Check className={`${iconMd} ${textSuccess} flex-shrink-0`} />
                )}
              </Option>
            );
          })}
        </Listbox>
      </DialogBody>
    </Dialog>
  );
}
