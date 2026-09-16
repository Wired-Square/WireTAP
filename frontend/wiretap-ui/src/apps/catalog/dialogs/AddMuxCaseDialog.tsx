// ui/src/apps/catalog/dialogs/AddMuxCaseDialog.tsx

import { useMemo } from "react";
import Dialog from "../../../components/Dialog";
import { Input, Textarea, FormField, SecondaryButton, SuccessButton } from "../../../components/forms";
import { h2, caption } from "../../../styles";
import type { ValidationError } from "../types";

export type AddMuxCaseDialogProps = {
  open: boolean;

  caseValue: string;
  setCaseValue: (v: string) => void;

  caseNotes: string;
  setCaseNotes: (v: string) => void;

  validationErrors: ValidationError[];
  clearValidation: () => void;

  onCancel: () => void;
  onAdd: () => void;
};

export default function AddMuxCaseDialog({
  open,
  caseValue,
  setCaseValue,
  caseNotes,
  setCaseNotes,
  validationErrors,
  clearValidation,
  onCancel,
  onAdd,
}: AddMuxCaseDialogProps) {
  const caseError = useMemo(() => validationErrors.find((e) => e.field === "case"), [validationErrors]);

  return (
    <Dialog isOpen={open} maxWidth="max-w-md">
      <div className="p-6">
        <h2 className={`${h2} mb-6`}>Add Mux Case</h2>

        <div className="space-y-4">
          <FormField label="Case Value" required variant="default">
            <Input
              variant="default"
              value={caseValue}
              onChange={(e) => {
                setCaseValue(e.target.value);
                if (caseError) clearValidation();
              }}
              placeholder="0, 1, 2, etc."
              onKeyDown={(e) => {
                if (e.key === "Enter" && caseValue.trim()) {
                  onAdd();
                }
              }}
            />
            {caseError && (
              <p className="mt-2 text-sm text-[color:var(--danger)]">{caseError.message}</p>
            )}
            <p className={`mt-2 ${caption}`}>
              Enter the case value (e.g., "0", "1", "2" for numeric cases or any string)
            </p>
          </FormField>

          <FormField label="Notes" variant="default">
            <Textarea
              variant="default"
              value={caseNotes}
              onChange={(e) => setCaseNotes(e.target.value)}
              placeholder="Optional notes about this case..."
              rows={2}
            />
          </FormField>
        </div>

        <div className="flex justify-end gap-3 mt-6">
          <SecondaryButton onClick={onCancel}>Cancel</SecondaryButton>
          <SuccessButton onClick={onAdd} disabled={!caseValue.trim()}>
            Add Case
          </SuccessButton>
        </div>
      </div>
    </Dialog>
  );
}
