// ui/src/apps/catalog/dialogs/EditMuxCaseDialog.tsx

import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import Dialog, { DialogBody, DialogFooter } from "../../../components/Dialog";
import { Input, Textarea, FormField, SecondaryButton, PrimaryButton } from "../../../components/forms";
import { caption } from "../../../styles";
import type { ValidationError } from "../types";

export type EditMuxCaseDialogProps = {
  open: boolean;

  caseValue: string;
  setCaseValue: (v: string) => void;

  caseNotes: string;
  setCaseNotes: (v: string) => void;

  validationErrors: ValidationError[];
  clearValidation: () => void;

  onCancel: () => void;
  onSave: () => void;
};

export default function EditMuxCaseDialog({
  open,
  caseValue,
  setCaseValue,
  caseNotes,
  setCaseNotes,
  validationErrors,
  clearValidation,
  onCancel,
  onSave,
}: EditMuxCaseDialogProps) {
  const { t } = useTranslation("catalog");
  const caseError = useMemo(() => validationErrors.find((e) => e.field === "case"), [validationErrors]);

  return (
    <Dialog isOpen={open} onClose={onCancel} title="Edit Mux Case">
      <DialogBody className="space-y-4">
        <FormField label="Case Value" required variant="default">
          <Input
            size="lg"
            value={caseValue}
            onChange={(e) => {
              setCaseValue(e.target.value);
              if (caseError) clearValidation();
            }}
            placeholder="0, 1, 2, etc."
            onKeyDown={(e) => {
              if (e.key === "Enter" && caseValue.trim()) {
                onSave();
              }
            }}
          />
          {caseError && (
            <p className="mt-2 text-sm text-danger">{caseError.message}</p>
          )}
          <p className={`mt-2 ${caption}`}>
            Enter the case value (e.g., "0", "1", "2" for numeric cases or any string)
          </p>
        </FormField>

        <FormField label={t("shared.notes")} variant="default">
          <Textarea
            size="lg"
            value={caseNotes}
            onChange={(e) => setCaseNotes(e.target.value)}
            placeholder={t("shared.notesPlaceholderCase")}
            rows={2}
          />
        </FormField>
      </DialogBody>
      <DialogFooter>
        <SecondaryButton onClick={onCancel}>{t("common:actions.cancel")}</SecondaryButton>
        <PrimaryButton onClick={onSave} disabled={!caseValue.trim()}>
          {t("editor.saveChanges")}
        </PrimaryButton>
      </DialogFooter>
    </Dialog>
  );
}
