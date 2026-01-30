// ui/src/dialogs/SpeedPickerDialog.tsx

import { Check, X } from "lucide-react";
import { iconMd, iconLg } from "../styles/spacing";
import Dialog from "../components/Dialog";
import type { PlaybackSpeed } from "../components/TimeController";
import { h2, cardElevated, paddingCard, borderDefault, hoverLight, roundedDefault, textSuccess, textMedium } from "../styles";
import { SPEED_OPTIONS } from "./io-reader-picker/utils";

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
  const handleSelect = (newSpeed: PlaybackSpeed) => {
    onSpeedChange(newSpeed);
    onClose();
  };

  return (
    <Dialog isOpen={isOpen} onBackdropClick={onClose} maxWidth="max-w-sm">
      <div className={`${cardElevated} shadow-xl overflow-hidden`}>
        <div className={`${paddingCard} border-b ${borderDefault} flex items-center justify-between`}>
          <h2 className={h2}>
            Playback Speed
          </h2>
          <button
            onClick={onClose}
            className={`p-1 ${roundedDefault} ${hoverLight} transition-colors`}
          >
            <X className={iconLg} />
          </button>
        </div>
        <div className="max-h-[50vh] overflow-y-auto">
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
        </div>
      </div>
    </Dialog>
  );
}
