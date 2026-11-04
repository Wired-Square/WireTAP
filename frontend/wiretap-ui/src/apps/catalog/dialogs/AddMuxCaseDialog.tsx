// ui/src/apps/catalog/dialogs/AddMuxCaseDialog.tsx

import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import Dialog, { DialogBody, DialogFooter } from "../../../components/Dialog";
import { Input, Textarea, FormField, SecondaryButton, SuccessButton } from "../../../components/forms";
import { caption } from "../../../styles";
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
  const { t } = useTranslation("catalog");
  const caseError = useMemo(() => validationErrors.find((e) => e.field === "case"), [validationErrors]);

  return (
    <Dialog isOpen={open} onClose={onCancel} title={t("muxCaseDialog.addTitle")}>
      <DialogBody className="space-y-4">
        <FormField label={t("muxCaseDialog.caseValue")} required variant="default">
          <Input
            size="lg"
            value={caseValue}
            onChange={(e) => {
              setCaseValue(e.target.value);
              if (caseError) clearValidation();
            }}
            placeholder={t("muxCaseDialog.caseValuePlaceholder")}
            onKeyDown={(e) => {
              if (e.key === "Enter" && caseValue.trim()) {
                onAdd();
              }
            }}
          />
          {caseError && (
            <p className="mt-2 text-sm text-danger">{caseError.message}</p>
          )}
          <p className={`mt-2 ${caption}`}>
            {t("muxCaseDialog.caseValueHint")}
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
        <SuccessButton onClick={onAdd} disabled={!caseValue.trim()}>
          {t("muxCaseDialog.submit")}
        </SuccessButton>
      </DialogFooter>
    </Dialog>
  );
}
