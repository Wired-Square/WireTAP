// ui/src/apps/settings/components/rows/SettingRadioGroup.tsx
//
// A labelled inline radio group. Replaces the hand-rolled label + inline radios +
// help blocks in DisplayView and LocationsView.

import type { ReactNode } from "react";
import { labelDefault, helpText, flexRowGap2, textPrimary } from "../../../../styles";

interface RadioOption<T extends string> {
  value: T;
  label: ReactNode;
}

interface SettingRadioGroupProps<T extends string> {
  label: ReactNode;
  /** Radio group name (shared across the options). */
  name: string;
  value: T;
  options: readonly RadioOption<T>[];
  onChange: (value: T) => void;
  help?: ReactNode;
  /** Allow the options to wrap onto multiple lines. */
  wrap?: boolean;
}

export default function SettingRadioGroup<T extends string>({
  label,
  name,
  value,
  options,
  onChange,
  help,
  wrap,
}: SettingRadioGroupProps<T>) {
  return (
    <div className="space-y-2">
      <label className={labelDefault}>{label}</label>
      <div className={["flex gap-3", wrap ? "flex-wrap" : ""].filter(Boolean).join(" ")}>
        {options.map((opt) => (
          <label key={opt.value} className={`${flexRowGap2} text-sm ${textPrimary} cursor-pointer`}>
            <input
              type="radio"
              name={name}
              value={opt.value}
              checked={value === opt.value}
              onChange={() => onChange(opt.value)}
            />
            {opt.label}
          </label>
        ))}
      </div>
      {help != null && <p className={helpText}>{help}</p>}
    </div>
  );
}
