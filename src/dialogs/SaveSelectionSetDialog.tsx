// ui/src/dialogs/SaveSelectionSetDialog.tsx

import { useState, useEffect } from "react";
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
  const [name, setName] = useState("");

  // Reset form when dialog opens
  useEffect(() => {
    if (isOpen) {
      setName(`Selection Set ${new Date().toLocaleDateString()}`);
    }
  }, [isOpen]);

  const handleSave = () => {
    if (!name.trim()) return;
    onSave(name.trim());
    onClose();
  };

  return (
    <Dialog isOpen={isOpen} maxWidth="max-w-md">
      <div className="p-6 space-y-4">
        <h2 className="text-lg font-semibold text-[color:var(--text-primary)]">
          Save Selection Set
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
              placeholder="Selection set name"
              onKeyDown={(e) => {
                if (e.key === "Enter" && name.trim()) {
                  handleSave();
                }
              }}
              autoFocus
            />
          </div>

          <p className={helpText}>
            {frameCount} frame{frameCount !== 1 ? "s" : ""} will be saved
          </p>
        </div>

        <DialogFooter
          onCancel={onClose}
          onConfirm={handleSave}
          confirmLabel="Save"
          confirmDisabled={!name.trim()}
        />
      </div>
    </Dialog>
  );
}
