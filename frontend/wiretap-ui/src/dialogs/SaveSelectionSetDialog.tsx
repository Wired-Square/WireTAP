// ui/src/dialogs/SaveSelectionSetDialog.tsx

import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import Dialog, { DialogBody, DialogFooter } from "../components/Dialog";
import { SecondaryButton, PrimaryButton } from "../components/forms";
import Input from "../components/forms/Input";
import { labelSmall, helpText } from "../styles";

type Props = {
  isOpen: boolean;
  frameCount: number;
  onClose: () => void;
  onSave: (name: string) => void;
};

export default function SaveSelectionSetDialog({
  isOpen,
  frameCount,
  onClose,
  onSave,
}: Props) {
  const { t, i18n } = useTranslation("dialogs");
  const [name, setName] = useState("");

  // Reset form when dialog opens
  useEffect(() => {
    if (isOpen) {
      setName(t("saveSelectionSet.defaultName", { date: new Date().toLocaleDateString(i18n.language) }));
    }
  }, [isOpen, t, i18n.language]);

  const handleSave = () => {
    if (!name.trim()) return;
    onSave(name.trim());
    onClose();
  };

  return (
    <Dialog isOpen={isOpen} onClose={onClose} title={t("saveSelectionSet.title")}>
      <DialogBody className="space-y-4">
        <div className="space-y-3">
          {/* Name input */}
          <div className="space-y-1">
            <label className={labelSmall}>{t("saveSelectionSet.name")}</label>
            <Input
              size="lg"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t("saveSelectionSet.namePlaceholder")}
              onKeyDown={(e) => {
                if (e.key === "Enter" && name.trim()) {
                  handleSave();
                }
              }}
              autoFocus
            />
          </div>

          <p className={helpText}>{t("saveSelectionSet.frameCount", { count: frameCount })}</p>
        </div>
      </DialogBody>
      <DialogFooter>
        <SecondaryButton onClick={onClose}>{t("common:actions.cancel")}</SecondaryButton>
        <PrimaryButton onClick={handleSave} disabled={!name.trim()}>{t("common:actions.save")}</PrimaryButton>
      </DialogFooter>
    </Dialog>
  );
}
