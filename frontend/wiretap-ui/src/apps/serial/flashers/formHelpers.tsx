// src/apps/serial/flashers/formHelpers.tsx
//
// Shared form primitives used by every driver's OptionsPanel and the
// unified Flash view. Kept tiny and unstyled-by-default so each driver
// can compose them without copy-pasting Tailwind classes.

import type { ReactNode } from "react";
import {
  bgPrimary,
  borderDivider,
  textPrimary,
} from "../../../styles/colourTokens";

interface FieldProps {
  label: string;
  children: ReactNode;
}

export function Field({ label, children }: FieldProps) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[10px] uppercase tracking-wide text-[color:var(--text-muted)]">
        {label}
      </span>
      {children}
    </div>
  );
}

interface SelectOption {
  value: string;
  label: string;
}

interface SelectProps {
  value: string;
  onChange: (value: string) => void;
  options: SelectOption[];
  disabled?: boolean;
  className?: string;
}

export function Select({
  value,
  onChange,
  options,
  disabled,
  className,
}: SelectProps) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      disabled={disabled}
      className={`${bgPrimary} ${textPrimary} text-xs px-2 py-1 rounded border ${borderDivider} disabled:opacity-50 ${className ?? ""}`}
    >
      {options.map((opt) => (
        <option key={opt.value} value={opt.value}>
          {opt.label}
        </option>
      ))}
    </select>
  );
}

interface TextInputProps {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  placeholder?: string;
  /** Tailwind width class (`w-28`, `w-32`, …). */
  widthClass?: string;
}

export function TextInput({
  value,
  onChange,
  disabled,
  placeholder,
  widthClass = "w-28",
}: TextInputProps) {
  return (
    <input
      value={value}
      onChange={(e) => onChange(e.target.value)}
      disabled={disabled}
      placeholder={placeholder}
      className={`${bgPrimary} ${textPrimary} text-xs px-2 py-1 rounded border ${borderDivider} font-mono ${widthClass} disabled:opacity-50`}
    />
  );
}

interface ActionButtonProps {
  variant: "primary" | "cancel" | "danger";
  onClick: () => void;
  disabled?: boolean;
  children: ReactNode;
}

export function ActionButton({
  variant,
  onClick,
  disabled,
  children,
}: ActionButtonProps) {
  const styles =
    variant === "primary"
      ? "bg-sky-500/20 text-sky-300 hover:bg-sky-500/30"
      : variant === "danger"
        ? "bg-red-500/30 text-red-200 hover:bg-red-500/40"
        : "bg-red-500/20 text-red-300 hover:bg-red-500/30";
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`flex items-center gap-1 text-xs px-3 py-1.5 rounded ${styles} disabled:opacity-40 disabled:cursor-not-allowed`}
    >
      {children}
    </button>
  );
}

/**
 * Parse a hex (`0x…`) or decimal integer. Returns `null` for empty or
 * invalid input — callers should treat that as "no value supplied".
 */
export function parseHexOrDec(input: string): number | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const radix = trimmed.toLowerCase().startsWith("0x") ? 16 : 10;
  const value = parseInt(trimmed, radix);
  return Number.isNaN(value) ? null : value;
}
