// ui/src/components/forms/DialogButtons.tsx
// Standardized dialog button components for consistent styling

import type { ReactNode, ButtonHTMLAttributes } from "react";
import { disabledState, hoverLight } from "../../styles";

type ButtonProps = {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  className?: string;
  type?: ButtonHTMLAttributes<HTMLButtonElement>["type"];
};

/**
 * Primary action button (blue) for dialogs.
 * Used for: Save, Confirm, Create, etc.
 */
export function PrimaryButton({
  children,
  onClick,
  disabled = false,
  className = "",
  type = "button",
}: ButtonProps) {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={`px-4 py-2 text-sm rounded bg-blue-600 text-white hover:bg-blue-700 ${disabledState} ${className}`}
    >
      {children}
    </button>
  );
}

/**
 * Secondary action button (gray outline) for dialogs.
 * Used for: Cancel, Close, Back, etc.
 */
export function SecondaryButton({
  children,
  onClick,
  disabled = false,
  className = "",
  type = "button",
}: ButtonProps) {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={`px-4 py-2 text-sm rounded border border-[color:var(--border-default)] text-[color:var(--text-secondary)] ${hoverLight} ${disabledState} ${className}`}
    >
      {children}
    </button>
  );
}

/**
 * Danger action button (red) for dialogs.
 * Used for: Delete, Remove, Discard, etc.
 */
export function DangerButton({
  children,
  onClick,
  disabled = false,
  className = "",
  type = "button",
}: ButtonProps) {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={`px-4 py-2 text-sm rounded bg-red-600 text-white hover:bg-red-700 ${disabledState} ${className}`}
    >
      {children}
    </button>
  );
}

/**
 * Success action button (green) for dialogs.
 * Used for: Add, Create, etc.
 */
export function SuccessButton({
  children,
  onClick,
  disabled = false,
  className = "",
  type = "button",
}: ButtonProps) {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={`px-4 py-2 text-sm rounded bg-green-600 text-white hover:bg-green-700 ${disabledState} ${className}`}
    >
      {children}
    </button>
  );
}
