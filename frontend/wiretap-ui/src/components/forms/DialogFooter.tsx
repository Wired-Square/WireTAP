// ui/src/components/forms/DialogFooter.tsx
// Standardized dialog footer with consistent button layout

import type { ReactNode } from "react";
import { PrimaryButton, SecondaryButton, DangerButton } from "./DialogButtons";

type DialogFooterProps = {
  onCancel?: () => void;
  onConfirm?: () => void;
  cancelLabel?: string;
  confirmLabel?: string;
  confirmDisabled?: boolean;
  danger?: boolean;
  /** Additional content to show on the left side of the footer */
  leftContent?: ReactNode;
};

/**
 * Standard dialog footer with Cancel and Confirm buttons.
 * Use danger=true for destructive actions (shows red confirm button).
 *
 * @example
 * <DialogFooter
 *   onCancel={handleClose}
 *   onConfirm={handleSave}
 *   confirmLabel="Save"
 *   confirmDisabled={!isValid}
 * />
 */
export function DialogFooter({
  onCancel,
  onConfirm,
  cancelLabel = "Cancel",
  confirmLabel = "Save",
  confirmDisabled = false,
  danger = false,
  leftContent,
}: DialogFooterProps) {
  const ConfirmButton = danger ? DangerButton : PrimaryButton;

  return (
    <div className="flex items-center justify-between pt-2">
      <div>{leftContent}</div>
      <div className="flex justify-end gap-2">
        {onCancel && (
          <SecondaryButton onClick={onCancel}>{cancelLabel}</SecondaryButton>
        )}
        {onConfirm && (
          <ConfirmButton onClick={onConfirm} disabled={confirmDisabled}>
            {confirmLabel}
          </ConfirmButton>
        )}
      </div>
    </div>
  );
}
