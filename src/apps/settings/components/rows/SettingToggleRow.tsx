// ui/src/apps/settings/components/rows/SettingToggleRow.tsx
//
// A checkbox setting: label + optional help/warning text. Generalises the local
// ToggleRow that lived in McpServerView and the hand-rolled checkbox rows in the
// General/Captures/Privacy views.

import type { ReactNode } from "react";
import { AlertTriangle } from "lucide-react";
import { labelDefault, helpText, textWarning } from "../../../../styles";

interface SettingToggleRowProps {
  label: ReactNode;
  checked: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
  /** Prefix the help text with a warning triangle (for permission gates). */
  warn?: boolean;
  /** Description shown under the label. */
  help?: ReactNode;
}

export default function SettingToggleRow({
  label,
  checked,
  onChange,
  disabled,
  warn,
  help,
}: SettingToggleRowProps) {
  return (
    <div className="space-y-2">
      <label className="flex items-start gap-3 cursor-pointer">
        <input
          type="checkbox"
          checked={checked}
          disabled={disabled}
          onChange={(e) => onChange(e.target.checked)}
          className="mt-1"
        />
        <div>
          <span className={labelDefault}>{label}</span>
          {help != null && (
            <p className={warn ? `${helpText} flex items-start gap-1` : helpText}>
              {warn && <AlertTriangle size={14} className={`${textWarning} mt-0.5 shrink-0`} />}
              {warn ? <span>{help}</span> : help}
            </p>
          )}
        </div>
      </label>
    </div>
  );
}
