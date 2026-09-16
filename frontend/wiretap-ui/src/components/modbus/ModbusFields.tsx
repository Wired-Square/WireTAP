// ui/src/components/modbus/ModbusFields.tsx
//
// Shared form controls for Modbus discovery, used by the Discovery scan panels.
// The register/unit-id panels were repeating the same six-line label+input
// pattern for every field; these give it a name.

import type { ReactNode } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { Play } from "lucide-react";
import { bgSurface, borderDefault, textMuted } from "../../styles";
import { iconMd } from "../../styles/spacing";
import CheckboxField, { type CheckboxFieldProps } from "../forms/CheckboxField";
import type { ModbusRegisterType } from "../../api/io";

const CONTROL =
  "w-full px-2 py-1 rounded border border-[color:var(--border-default)] text-[color:var(--text-primary)]";

/** A labelled control in the compact scan-panel layout. */
export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex-1 space-y-1 min-w-0">
      <label className="text-[color:var(--text-muted)] block truncate">{label}</label>
      {children}
    </div>
  );
}

/** A row of fields sharing the available width. */
export function FieldRow({ children }: { children: ReactNode }) {
  return <div className="flex gap-3">{children}</div>;
}

/** A number input clamped to its bounds on every keystroke. */
export function NumberField({
  label,
  value,
  onChange,
  min,
  max,
  disabled,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
  disabled?: boolean;
}) {
  return (
    <Field label={label}>
      <input
        type="number"
        min={min}
        max={max}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(Math.max(min, Math.min(max, Number(e.target.value) || 0)))}
        className={`${CONTROL} ${bgSurface} disabled:opacity-50`}
      />
    </Field>
  );
}

/** A text input. */
export function TextField({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <Field label={label}>
      <input
        type="text"
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className={`${CONTROL} ${bgSurface}`}
      />
    </Field>
  );
}

/** A select over a fixed set of options. */
export function SelectField<T extends string>({
  label,
  value,
  onChange,
  options,
  disabled,
}: {
  label: string;
  value: T;
  onChange: (v: T) => void;
  options: Array<{ value: T; label: string }>;
  disabled?: boolean;
}) {
  return (
    <Field label={label}>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as T)}
        disabled={disabled}
        className={`${CONTROL} ${bgSurface} disabled:opacity-50`}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </Field>
  );
}

/** The shared checkbox, aligned to the baseline of the fields beside it. */
export function CheckboxRow(props: CheckboxFieldProps) {
  return (
    <div className="flex-1 pt-5 min-w-0">
      <CheckboxField {...props} />
    </div>
  );
}

/** The primary action of a Modbus tool panel. */
export function RunButton({
  label,
  onClick,
  disabled,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`flex items-center justify-center gap-2 w-full px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
        disabled
          ? "bg-[var(--bg-surface)] text-[color:var(--text-muted)] cursor-not-allowed"
          : "bg-purple-600 hover:bg-purple-700 text-white"
      }`}
    >
      <Play className={iconMd} />
      {label}
    </button>
  );
}

/**
 * The sentence a scan panel closes with, above its Run button.
 *
 * Takes `ready` rather than being three separate ternaries because every panel
 * needs the same fallback: with no host there is nothing to describe, and the
 * disabled Run button above it should say why.
 */
export function ScanNote({ ready, children }: { ready: boolean; children: ReactNode }) {
  const { t } = useTranslation("discovery");
  return (
    <p className={`${textMuted} pt-2 border-t ${borderDefault}`}>
      {ready ? children : t("modbusConnection.needHost")}
    </p>
  );
}

/**
 * The four readable register types, for a `SelectField`.
 *
 * Shared because it was written out three times — the two scan panels and the
 * picker's poll range — against two i18n namespaces, and the labels had already
 * drifted ("FC 3" against "FC03") for what is the same dropdown. The strings
 * live in `common` for the same reason every other shared control's do.
 */
export function registerTypeOptions(
  t: TFunction
): Array<{ value: ModbusRegisterType; label: string }> {
  return [
    { value: "holding", label: t("common:modbus.holding") },
    { value: "input", label: t("common:modbus.input") },
    { value: "coil", label: t("common:modbus.coil") },
    { value: "discrete", label: t("common:modbus.discrete") },
  ];
}
