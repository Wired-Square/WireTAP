// ui/src/components/HeaderFieldFilter.tsx
// Reusable filter component for header fields (Direction, Source, custom fields)

import { useMemo } from "react";
import { X } from "lucide-react";
import { iconSm } from "../styles/spacing";
import { labelSmall } from "../styles/typography";

export type HeaderFieldOption = {
  /** Raw numeric value */
  value: number;
  /** Display string (e.g., "0x0", "0x1B9D4") */
  display: string;
  /** Number of frames seen with this value */
  count: number;
};

export type HeaderFieldFilterProps = {
  /** Field name to display (e.g., "Direction", "Source") */
  fieldName: string;
  /** Available options (built dynamically from seen frames) */
  options: HeaderFieldOption[];
  /** Currently selected values (empty = show all) */
  selectedValues: Set<number>;
  /** Called when a value is toggled */
  onToggle: (value: number) => void;
  /** Called to clear all filters for this field */
  onClear: () => void;
  /** Whether to show counts next to each option */
  showCounts?: boolean;
  /** Compact mode for inline display */
  compact?: boolean;
};

/**
 * A filter chip/badge component for filtering by header field values.
 * Options are built dynamically as frames arrive.
 */
export default function HeaderFieldFilter({
  fieldName,
  options,
  selectedValues,
  onToggle,
  onClear,
  showCounts = true,
  compact = false,
}: HeaderFieldFilterProps) {
  const hasSelection = selectedValues.size > 0;
  const sortedOptions = useMemo(
    () => [...options].sort((a, b) => a.value - b.value),
    [options]
  );

  if (options.length === 0) {
    return null;
  }

  // Don't show filter if there's only one option
  if (options.length === 1) {
    return null;
  }

  return (
    <div className={`flex items-center gap-2 ${compact ? "" : "flex-wrap"}`}>
      <span className={labelSmall}>
        {fieldName}:
      </span>

      <div className="flex items-center gap-1 flex-wrap">
        {sortedOptions.map((option) => {
          const isSelected = selectedValues.has(option.value);
          const isActive = hasSelection ? isSelected : true;

          return (
            <button
              key={option.value}
              onClick={() => onToggle(option.value)}
              className={`
                px-2 py-0.5 text-xs font-mono rounded transition-colors
                ${isActive
                  ? "bg-[var(--status-purple-bg)] text-[color:var(--text-purple)] border border-[color:var(--status-purple-border)]"
                  : "bg-[var(--bg-surface)] text-[color:var(--text-muted)] border border-transparent"
                }
                hover:bg-[var(--status-purple-bg-hover)]
              `}
              title={`${isSelected ? "Hide" : "Show"} ${fieldName} ${option.display}`}
            >
              {option.display}
              {showCounts && (
                <span className="ml-1 opacity-60">({option.count})</span>
              )}
            </button>
          );
        })}

        {hasSelection && (
          <button
            onClick={onClear}
            className="p-0.5 text-[color:var(--text-muted)] hover:text-[color:var(--text-secondary)] transition-colors"
            title={`Clear ${fieldName} filter`}
          >
            <X className={iconSm} />
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * Helper to build HeaderFieldOptions from decoded frames.
 * Call this in useMemo with dependency on the decoded frames map.
 */
export function buildHeaderFieldOptions(
  decodedFrames: Map<number, { headerFields: Array<{ name: string; value: number; display: string }> }>,
  fieldName: string
): HeaderFieldOption[] {
  const optionMap = new Map<number, { value: number; display: string; count: number }>();

  for (const frame of decodedFrames.values()) {
    for (const field of frame.headerFields) {
      if (field.name === fieldName) {
        const existing = optionMap.get(field.value);
        if (existing) {
          existing.count++;
        } else {
          optionMap.set(field.value, {
            value: field.value,
            display: field.display,
            count: 1,
          });
        }
      }
    }
  }

  return Array.from(optionMap.values());
}

/**
 * Helper to get all unique header field names from decoded frames.
 */
export function getUniqueHeaderFieldNames(
  decodedFrames: Map<number, { headerFields: Array<{ name: string }> }>
): string[] {
  const names = new Set<string>();

  for (const frame of decodedFrames.values()) {
    for (const field of frame.headerFields) {
      names.add(field.name);
    }
  }

  return Array.from(names).sort();
}
