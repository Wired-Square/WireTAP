// ui/src/apps/settings/components/rows/SettingRadioGroup.tsx
//
// A labelled inline radio group. Replaces the hand-rolled label + inline radios +
// help blocks in DisplayView and LocationsView.

import type { ReactNode } from "react";
import { labelDefault, helpText, flexRowGap2, textPrimary } from "../../../../styles";

interface RadioOption<T extends string> {
  value: T;
  label: ReactNode;
  /** Explanatory line under the label. Only rendered when `stacked`. */
  description?: ReactNode;
}

interface SettingRadioGroupProps<T extends string> {
  label?: ReactNode;
  /** Radio group name (shared across the options, so arrow keys move between them). */
  name: string;
  value: T;
  options: readonly RadioOption<T>[];
  onChange: (value: T) => void;
  help?: ReactNode;
  /** Allow the options to wrap onto multiple lines. */
  wrap?: boolean;
  /** One option per row, with room for each option's description. */
  stacked?: boolean;
}

export default function SettingRadioGroup<T extends string>({
  label,
  name,
  value,
  options,
  onChange,
  help,
  wrap,
  stacked,
}: SettingRadioGroupProps<T>) {
  return (
    <div className="space-y-2">
      {label != null && <label className={labelDefault}>{label}</label>}
      <div
        className={[stacked ? "flex flex-col gap-2" : "flex gap-3", wrap ? "flex-wrap" : ""]
          .filter(Boolean)
          .join(" ")}
      >
        {options.map((opt) => (
          <label
            key={opt.value}
            className={`${stacked ? "flex items-start gap-2" : flexRowGap2} text-sm ${textPrimary} cursor-pointer`}
          >
            <input
              type="radio"
              name={name}
              value={opt.value}
              checked={value === opt.value}
              onChange={() => onChange(opt.value)}
              className={stacked ? "mt-1" : undefined}
            />
            {opt.description != null ? (
              <span>
                {opt.label}
                <span className={`block ${helpText}`}>{opt.description}</span>
              </span>
            ) : (
              opt.label
            )}
          </label>
        ))}
      </div>
      {help != null && <p className={helpText}>{help}</p>}
    </div>
  );
}
