// ui/src/apps/decoder/dialogs/FilterDialog.tsx

import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import Dialog from "../../../components/Dialog";
import { DialogFooter } from "../../../components/forms/DialogFooter";
import { caption, sectionHeaderText, focusRing, bgSurface } from "../../../styles";

type Props = {
  isOpen: boolean;
  onClose: () => void;
  minFrameLength: number;
  frameIdFilter: string;
  onSave: (minFrameLength: number, frameIdFilter: string) => void;
};

export default function FilterDialog({
  isOpen,
  onClose,
  minFrameLength,
  frameIdFilter,
  onSave,
}: Props) {
  const { t } = useTranslation("decoder");
  const [lengthValue, setLengthValue] = useState(minFrameLength);
  const [idFilter, setIdFilter] = useState(frameIdFilter);

  // Reset values when dialog opens
  useEffect(() => {
    if (isOpen) {
      setLengthValue(minFrameLength);
      setIdFilter(frameIdFilter);
    }
  }, [isOpen, minFrameLength, frameIdFilter]);

  const handleSave = () => {
    onSave(lengthValue, idFilter);
    onClose();
  };

  const handleClear = () => {
    onSave(0, '');
    onClose();
  };

  const hasFilters = minFrameLength > 0 || frameIdFilter.trim() !== '';

  return (
    <Dialog isOpen={isOpen} maxWidth="max-w-sm">
      <div className="p-6 space-y-4">
        <h2 className="text-lg font-semibold text-[color:var(--text-primary)]">
          {t("filterDialog.title")}
        </h2>

        {/* Frame ID Filter */}
        <div className="space-y-2">
          <label className={`block ${sectionHeaderText}`}>
            {t("filterDialog.frameIdsLabel")}
          </label>
          <input
            type="text"
            value={idFilter}
            onChange={(e) => setIdFilter(e.target.value)}
            placeholder={t("filterDialog.frameIdsPlaceholder")}
            className={`w-full px-3 py-2 rounded-lg border border-[color:var(--border-default)] ${bgSurface} text-[color:var(--text-primary)] font-mono ${focusRing}`}
          />
          <p className={caption}>{t("filterDialog.frameIdsHelp")}</p>
        </div>

        {/* Minimum Frame Length */}
        <div className="space-y-2">
          <label className={`block ${sectionHeaderText}`}>
            {t("filterDialog.minLengthLabel")}
          </label>
          <input
            type="number"
            min={0}
            max={255}
            value={lengthValue}
            onChange={(e) => setLengthValue(Math.max(0, parseInt(e.target.value) || 0))}
            className={`w-full px-3 py-2 rounded-lg border border-[color:var(--border-default)] ${bgSurface} text-[color:var(--text-primary)] ${focusRing}`}
          />
          <p className={caption}>{t("filterDialog.minLengthHelp")}</p>
        </div>

        <DialogFooter
          onCancel={onClose}
          onConfirm={handleSave}
          confirmLabel={t("filterDialog.apply")}
          leftContent={
            hasFilters ? (
              <button
                type="button"
                onClick={handleClear}
                className="px-4 py-2 text-sm rounded-lg text-[color:var(--text-danger)] hover:bg-[var(--hover-danger-bg)]"
              >
                {t("filterDialog.clearAll")}
              </button>
            ) : undefined
          }
        />
      </div>
    </Dialog>
  );
}
