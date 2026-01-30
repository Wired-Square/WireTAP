// ui/src/apps/catalog/dialogs/ValidationErrorsDialog.tsx

import { AlertTriangle, CheckCircle, X } from "lucide-react";
import { iconMd, iconLg, iconXl } from "../../../styles/spacing";
import Dialog from "../../../components/Dialog";
import { SecondaryButton } from "../../../components/forms";
import { h2, caption } from "../../../styles";
import type { ValidationError } from "../types";

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
    <Dialog isOpen={open} maxWidth="max-w-2xl">
      <div className="p-6">
        {/* Header */}
        <div className="flex items-start justify-between mb-4">
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
              <h2 className={h2}>
                {isValidCatalog ? "Validation Passed" : "Validation Warnings"}
              </h2>
              {hasErrors && (
                <p className="text-sm text-[color:var(--text-muted)]">
                  {errors.length} {errors.length === 1 ? "issue" : "issues"} found
                </p>
              )}
            </div>
          </div>
          <button
            onClick={onClose}
            className="text-[color:var(--text-muted)] hover:text-[color:var(--text-secondary)] transition-colors"
          >
            <X className={iconLg} />
          </button>
        </div>

        {/* Content */}
        {isValidCatalog ? (
          <p className="text-[color:var(--text-secondary)] mb-6">
            The catalog is valid and ready for use.
          </p>
        ) : (
          <div className="mb-6 max-h-80 overflow-y-auto">
            <div className="space-y-2">
              {errors.map((error, idx) => (
                <div
                  key={idx}
                  className="bg-[var(--status-warning-bg)] border border-[color:var(--status-warning-border)] rounded-lg p-3"
                >
                  <div className="flex items-start gap-2">
                    <AlertTriangle className={`${iconMd} text-[color:var(--text-amber)] mt-0.5 flex-shrink-0`} />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-[color:var(--text-secondary)]">
                        {error.message}
                      </p>
                      <p className={`${caption} mt-1 font-mono`}>
                        {error.field}
                      </p>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Actions */}
        <div className="flex justify-end gap-3">
          <SecondaryButton onClick={onClose}>Close</SecondaryButton>
        </div>
      </div>
    </Dialog>
  );
}
