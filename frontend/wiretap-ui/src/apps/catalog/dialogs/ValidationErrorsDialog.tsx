// ui/src/apps/catalog/dialogs/ValidationErrorsDialog.tsx

import { AlertTriangle, CheckCircle } from "lucide-react";
import { iconXl } from "../../../styles/spacing";
import Dialog, { DialogBody, DialogFooter, DialogHeader, DialogTitle } from "../../../components/Dialog";
import { useTranslation } from "react-i18next";
import { SecondaryButton } from "../../../components/forms";
import type { ValidationError } from "../types";
import { Alert } from "../../../components/Alert";
type Props = {
  open: boolean;
  errors: ValidationError[];
  isValid: boolean | null;
  onClose: () => void;
};

export default function ValidationErrorsDialog({ open, errors, isValid, onClose }: Props) {
  const { t } = useTranslation("catalog");
  const hasErrors = errors.length > 0;
  const isValidCatalog = isValid === true && !hasErrors;

  return (
    <Dialog isOpen={open} size="xl" onClose={onClose}>
      <DialogHeader>
        <div className="flex items-center gap-3">
          <div
            className={`w-12 h-12 rounded-lg flex items-center justify-center ${
              isValidCatalog
                ? "bg-success"
                : "bg-warning"
            }`}
          >
            {isValidCatalog ? (
              <CheckCircle className={`${iconXl} text-green`} />
            ) : (
              <AlertTriangle className={`${iconXl} text-amber`} />
            )}
          </div>
          <div>
            <DialogTitle>
              {t(isValidCatalog ? "validationDialog.passed" : "validationDialog.warnings")}
            </DialogTitle>
            {hasErrors && (
              <p className="text-sm text-muted">
                {t("validationDialog.issuesFound", { count: errors.length })}
              </p>
            )}
          </div>
        </div>
      </DialogHeader>
      <DialogBody>
        {isValidCatalog ? (
          <p className="text-secondary">
            {t("validationDialog.valid")}
          </p>
        ) : (
          <div className="space-y-2">
            {errors.map((error, idx) => (
              <Alert key={idx} tone="warning">
                <p>{error.message}</p>
                <p className="text-xs mt-1 font-mono">{error.field}</p>
              </Alert>
            ))}
          </div>
        )}
      </DialogBody>
      <DialogFooter>
        <SecondaryButton onClick={onClose}>{t("common:actions.close")}</SecondaryButton>
      </DialogFooter>
    </Dialog>
  );
}
