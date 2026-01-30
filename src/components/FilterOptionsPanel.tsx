// ui/src/components/FilterOptionsPanel.tsx
//
// Shared filter options panel used by:
// - IoReaderPickerDialog (for capture-time filtering)
// - FilterDialog (for post-capture filtering)
//
// Supports two styling variants:
// - "panel": Compact inline style for dialogs/panels
// - "card": Full card style for standalone dialogs

import { useState, useEffect } from "react";
import { caption, captionMuted } from "../styles/typography";
import { bgSurface } from "../styles";

/** Filter configuration */
export interface FilterConfig {
  /** Minimum frame length (0 = no filter) */
  minFrameLength: number;
}

interface Props {
  /** Current filter configuration */
  config: FilterConfig;
  /** Called when configuration changes */
  onChange: (config: FilterConfig) => void;
  /** Visual variant */
  variant?: "panel" | "card";
  /** Whether the component is disabled */
  disabled?: boolean;
}

export default function FilterOptionsPanel({
  config,
  onChange,
  variant = "panel",
  disabled = false,
}: Props) {
  const [minLength, setMinLength] = useState(config.minFrameLength);

  // Sync local state when config changes externally
  useEffect(() => {
    setMinLength(config.minFrameLength);
  }, [config.minFrameLength]);

  const handleMinLengthChange = (value: number) => {
    const clamped = Math.max(0, value);
    setMinLength(clamped);
    onChange({ minFrameLength: clamped });
  };

  // Card variant - fuller style for standalone dialogs
  if (variant === "card") {
    return (
      <div className="space-y-3">
        <label className="block text-sm">
          <span className="text-gray-300">Minimum frame length:</span>
          <input
            type="number"
            value={minLength}
            onChange={(e) => handleMinLengthChange(Number(e.target.value))}
            disabled={disabled}
            className="w-full mt-1 px-3 py-2 bg-gray-700 border border-gray-600 rounded text-white disabled:opacity-50"
            min={0}
          />
          <span className="text-xs text-gray-500 mt-1 block">
            {minLength === 0 ? "No filter - all frames accepted" : "Frames shorter than this will be discarded"}
          </span>
        </label>
      </div>
    );
  }

  // Panel variant - compact style for inline panels
  return (
    <div className="space-y-2">
      <div>
        <label className={`block ${caption} mb-1`}>
          Min frame length
        </label>
        <input
          type="number"
          min="0"
          value={minLength}
          onChange={(e) => handleMinLengthChange(Number(e.target.value))}
          disabled={disabled}
          className={`w-full px-2 py-1.5 text-xs rounded border-[color:var(--border-default)] border ${bgSurface} text-[color:var(--text-secondary)] disabled:opacity-50`}
        />
        <div className={`${captionMuted} mt-0.5`}>
          {minLength === 0 ? "No filter" : `Discard frames < ${minLength} bytes`}
        </div>
      </div>
    </div>
  );
}
