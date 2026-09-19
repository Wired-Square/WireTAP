// ui/src/apps/catalog/dialogs/ValidationErrorsDialog.tsx

import { AlertTriangle, CheckCircle } from "lucide-react";
import { iconXl } from "../../../styles/spacing";
import Dialog, { DialogBody, DialogFooter, DialogHeader, DialogTitle } from "../../../components/Dialog";
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
  const hasErrors = errors.length > 0;
  const isValidCatalog = isValid === true && !hasErrors;

  return (
    <Dialog isOpen={open} size="xl" onClose={onClose}>
      <DialogHeader>
        <div className="flex items-center gap-3">
          <div
            className={`w-12 h-12 rounded-lg flex items-center justify-center ${
              isValidCatalog
                ? "bg-[var(--status-success-bg)]"
                : "bg-[var(--status-warning-bg)]"
            }`}
          >
            {isValidCatalog ? (
              <CheckCircle className={`${iconXl} text-[color:var(--text-green)]`} />
            ) : (
              <AlertTriangle className={`${iconXl} text-[color:var(--text-amber)]`} />
            )}
          </div>
          <div>
            <DialogTitle>
              {isValidCatalog ? "Validation Passed" : "Validation Warnings"}
            </DialogTitle>
            {hasErrors && (
              <p className="text-sm text-[color:var(--text-muted)]">
                {errors.length} {errors.length === 1 ? "issue" : "issues"} found
              </p>
            )}
          </div>
        </div>
      </DialogHeader>
      <DialogBody>
        {isValidCatalog ? (
          <p className="text-[color:var(--text-secondary)]">
            The catalog is valid and ready for use.
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
        <SecondaryButton onClick={onClose}>Close</SecondaryButton>
      </DialogFooter>
    </Dialog>
  );
}
