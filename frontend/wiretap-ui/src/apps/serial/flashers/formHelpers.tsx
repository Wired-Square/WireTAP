// src/apps/serial/flashers/formHelpers.tsx
//
// Shared form primitives used by every driver's OptionsPanel and the
// unified Flash view. Kept tiny and unstyled-by-default so each driver
// can compose them without copy-pasting class strings.

import type { ReactNode } from "react";
import { Button } from "../../../components/Button";
import { Input, Select as SelectField } from "../../../components/forms";

interface FieldProps {
  label: string;
  children: ReactNode;
}

export function Field({ label, children }: FieldProps) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-2xs uppercase tracking-wide text-muted">
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
}

export function Select({ value, onChange, options, disabled }: SelectProps) {
  return (
    <SelectField
      value={value}
      onChange={(e) => onChange(e.target.value)}
      disabled={disabled}
      size="sm"
      className="w-auto"
    >
      {options.map((opt) => (
        <option key={opt.value} value={opt.value}>
          {opt.label}
        </option>
      ))}
    </SelectField>
  );
}

interface TextInputProps {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  placeholder?: string;
  /** Width utility class (`w-28`, `w-32`, …). */
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
    <Input
      value={value}
      onChange={(e) => onChange(e.target.value)}
      disabled={disabled}
      placeholder={placeholder}
      size="sm"
      mono
      className={widthClass}
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
  return (
    <Button
      onClick={onClick}
      disabled={disabled}
      variant={variant === "danger" ? "solid" : "tonal"}
      tone={variant === "primary" ? "primary" : "danger"}
      size="sm"
    >
      {children}
    </Button>
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
