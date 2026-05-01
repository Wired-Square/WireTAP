// ui/src/dialogs/SaveSelectionSetDialog.tsx

import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import Dialog from "../components/Dialog";
import Input from "../components/forms/Input";
import { DialogFooter } from "../components/forms/DialogFooter";
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
    <Dialog isOpen={isOpen} maxWidth="max-w-md">
      <div className="p-6 space-y-4">
        <h2 className="text-lg font-semibold text-[color:var(--text-primary)]">
          {t("saveSelectionSet.title")}
        </h2>

        <div className="space-y-3">
          {/* Name input */}
          <div className="space-y-1">
            <label className={labelSmall}>{t("saveSelectionSet.name")}</label>
            <Input
              variant="simple"
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

        <DialogFooter
          onCancel={onClose}
          onConfirm={handleSave}
          confirmLabel={t("common:actions.save")}
          confirmDisabled={!name.trim()}
        />
      </div>
    </Dialog>
  );
}
