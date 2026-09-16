// ui/src/apps/settings/components/rows/SettingDirectoryRow.tsx
//
// A directory path field: label + text input + folder-picker button + optional
// validation error + help. Replaces the three identical directory blocks in
// LocationsView.

import type { ReactNode } from "react";
import { FolderOpen, AlertCircle } from "lucide-react";
import {
  textMedium,
  textMuted,
  textWarning,
  focusRing,
  folderPickerButton,
  iconLg,
  iconMd,
} from "../../../../styles";

interface SettingDirectoryRowProps {
  label: ReactNode;
  value: string;
  onChange: (value: string) => void;
  onPick: () => void;
  placeholder?: string;
  browseTooltip?: string;
  /** Validation error message (e.g. "Directory is not writable"). */
  error?: string | null;
  help?: ReactNode;
}

export default function SettingDirectoryRow({
  label,
  value,
  onChange,
  onPick,
  placeholder,
  browseTooltip,
  error,
  help,
}: SettingDirectoryRowProps) {
  return (
    <div className="mb-6">
      <label className={`block ${textMedium} mb-2`}>{label}</label>
      <div className="flex gap-2">
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className={`flex-1 px-4 py-2 bg-[var(--bg-surface)] border border-[color:var(--border-default)] rounded-lg text-[color:var(--text-primary)] ${focusRing}`}
          placeholder={placeholder}
        />
        <button onClick={onPick} className={folderPickerButton} title={browseTooltip}>
          <FolderOpen className={`${iconLg} ${textMuted}`} />
        </button>
      </div>
      {error && (
        <div className={`mt-2 flex items-center gap-2 text-sm ${textWarning}`}>
          <AlertCircle className={iconMd} />
          <span>{error}</span>
        </div>
      )}
      {help != null && <p className={`mt-2 text-sm ${textMuted}`}>{help}</p>}
    </div>
  );
}
