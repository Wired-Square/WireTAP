// ui/src/apps/catalog/dialogs/EditNodeDialog.tsx

import { useMemo } from "react";
import Dialog from "../../../components/Dialog";
import { Input, Textarea, FormField, SecondaryButton, PrimaryButton } from "../../../components/forms";
import { h2, caption } from "../../../styles";
import type { ValidationError } from "../types";

export type EditNodeDialogProps = {
  open: boolean;

  nodeName: string;
  setNodeName: (v: string) => void;

  nodeNotes: string;
  setNodeNotes: (v: string) => void;

  validationErrors: ValidationError[];
  clearValidation: () => void;

  onCancel: () => void;
  onSave: () => void;
};

export default function EditNodeDialog({
  open,
  nodeName,
  setNodeName,
  nodeNotes,
  setNodeNotes,
  validationErrors,
  clearValidation,
  onCancel,
  onSave,
}: EditNodeDialogProps) {
  const nodeError = useMemo(() => validationErrors.find((e) => e.field === "node"), [validationErrors]);

  return (
    <Dialog isOpen={open} maxWidth="max-w-md">
      <div className="p-6">
        <h2 className={`${h2} mb-6`}>Edit Node</h2>

        <div className="space-y-4">
          <FormField label="Node Name" required variant="default">
            <Input
              variant="default"
              value={nodeName}
              onChange={(e) => {
                setNodeName(e.target.value);
                if (nodeError) clearValidation();
              }}
              placeholder="inverter, battery, etc."
              onKeyDown={(e) => {
                if (e.key === "Enter" && nodeName.trim()) {
                  onSave();
                }
              }}
            />
            {nodeError && (
              <p className="mt-2 text-sm text-[color:var(--danger)]">{nodeError.message}</p>
            )}
            <p className={`mt-2 ${caption}`}>
              Changing the name will update all frames that reference this node as transmitter.
            </p>
          </FormField>

          <FormField label="Notes" variant="default">
            <Textarea
              variant="default"
              value={nodeNotes}
              onChange={(e) => setNodeNotes(e.target.value)}
              placeholder="Optional notes about this node..."
              rows={2}
            />
          </FormField>
        </div>

        <div className="flex justify-end gap-3 mt-6">
          <SecondaryButton onClick={onCancel}>Cancel</SecondaryButton>
          <PrimaryButton onClick={onSave} disabled={!nodeName.trim()}>
            Save Changes
          </PrimaryButton>
        </div>
      </div>
    </Dialog>
  );
}
