// ui/src/components/forms/CheckboxField.tsx
//
// A checkbox with its label — the shape a checkbox always appears in.

import type { ReactNode } from "react";
import { checkboxDefault } from "../../styles/inputStyles";
import { caption } from "../../styles/typography";

export interface CheckboxFieldProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: ReactNode;
  disabled?: boolean;
  /** Label typography. Defaults to `caption`; pass `textMedium` to give it weight. */
  labelClass?: string;
}

export default function CheckboxField({
  checked,
  onChange,
  label,
  disabled,
  labelClass = caption,
}: CheckboxFieldProps) {
  return (
    <label className="flex items-center gap-2 cursor-pointer">
      <input
        type="checkbox"
        className={checkboxDefault}
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        disabled={disabled}
      />
      <span className={labelClass}>{label}</span>
    </label>
  );
}
