// ui/src/apps/decoder/dialogs/FilterDialog.tsx

import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import Dialog, { DialogBody, DialogFooter } from "../../../components/Dialog";
import { caption, sectionHeaderText } from "../../../styles";
import { Button } from "../../../components/Button";
import { Input, SecondaryButton, PrimaryButton } from "../../../components/forms";

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
    <Dialog isOpen={isOpen} onClose={onClose} size="sm" title={t("filterDialog.title")}>
      <DialogBody className="space-y-4">
        {/* Frame ID Filter */}
        <div className="space-y-2">
          <label className={`block ${sectionHeaderText}`}>
            {t("filterDialog.frameIdsLabel")}
          </label>
          <Input
            type="text"
            value={idFilter}
            onChange={(e) => setIdFilter(e.target.value)}
            placeholder={t("filterDialog.frameIdsPlaceholder")}
            size="lg"
            mono
          />
          <p className={caption}>{t("filterDialog.frameIdsHelp")}</p>
        </div>

        {/* Minimum Frame Length */}
        <div className="space-y-2">
          <label className={`block ${sectionHeaderText}`}>
            {t("filterDialog.minLengthLabel")}
          </label>
          <Input
            type="number"
            min={0}
            max={255}
            value={lengthValue}
            onChange={(e) => setLengthValue(Math.max(0, parseInt(e.target.value) || 0))}
            size="lg"
          />
          <p className={caption}>{t("filterDialog.minLengthHelp")}</p>
        </div>
      </DialogBody>
      <DialogFooter className="justify-between">
        <div>
          {hasFilters && (
            <Button onClick={handleClear} variant="ghost" tone="danger" size="lg">
              {t("filterDialog.clearAll")}
            </Button>
          )}
        </div>
        <div className="flex gap-2">
          <SecondaryButton onClick={onClose}>{t("common:actions.cancel")}</SecondaryButton>
          <PrimaryButton onClick={handleSave}>{t("filterDialog.apply")}</PrimaryButton>
        </div>
      </DialogFooter>
    </Dialog>
  );
}
