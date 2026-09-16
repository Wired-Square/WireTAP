// ui/src/apps/settings/components/rows/SettingRow.tsx
//
// A labelled settings control: label + optional help text + the control itself.
// Replaces the `space-y-2 / label(labelDefault) / p(helpText) / <control>` block
// hand-rolled throughout the settings views.

import type { ReactNode } from "react";
import { labelDefault, helpText } from "../../../../styles";

interface SettingRowProps {
  label: ReactNode;
  /** Description shown under the label. */
  help?: ReactNode;
  /** Associates the label with a control's id (for accessibility). */
  htmlFor?: string;
  /** Extra classes on the wrapper (e.g. `max-w-xs` to constrain width). */
  className?: string;
  /** The control (Input, Select, …). */
  children: ReactNode;
}

export default function SettingRow({ label, help, htmlFor, className, children }: SettingRowProps) {
  return (
    <div className={["space-y-2", className].filter(Boolean).join(" ")}>
      <label className={labelDefault} htmlFor={htmlFor}>
        {label}
      </label>
      {help != null && <p className={helpText}>{help}</p>}
      {children}
    </div>
  );
}
