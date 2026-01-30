// ui/src/components/FramePicker.tsx

import { useMemo, memo, useState } from "react";
import { ChevronDown, ChevronRight, AlertTriangle, Save, Star, CheckCheck, SquareSlash } from "lucide-react";
import { iconSm } from "../styles/spacing";
import { labelSmall, caption, captionMuted } from "../styles/typography";
import { hoverLight } from "../styles";
import { formatFrameId } from "../utils/frameIds";
import type { FrameInfo } from "../types/common";

type FrameWarning = {
  type: "length-mismatch";
  count: number;
  message: string;
};

type Props = {
  frames: FrameInfo[];
  selected: Set<number>;
  onToggle: (id: number) => void;
  onBulkSelect: (bus: number, select: boolean) => void;
  displayFrameIdFormat: "hex" | "decimal";
  actions?: React.ReactNode;
  onSelectAll?: () => void;
  onDeselectAll?: () => void;
  // Selection set props
  activeSelectionSetId?: string | null;
  selectionSetDirty?: boolean;
  onSaveSelectionSet?: () => void;
  onOpenSelectionSetPicker?: () => void;
  // Default expanded state
  defaultExpanded?: boolean;
  // Disable inner scroll (for use in dialogs that already scroll)
  noInnerScroll?: boolean;
};

function FramePicker({
  frames,
  selected,
  onToggle,
  onBulkSelect,
  displayFrameIdFormat,
  actions,
  onSelectAll,
  onDeselectAll,
  activeSelectionSetId,
  selectionSetDirty,
  onSaveSelectionSet,
  onOpenSelectionSetPicker,
  defaultExpanded = false,
  noInnerScroll = false,
}: Props) {
  const sortedFrames = useMemo(
    () => [...frames].sort((a, b) => a.id - b.id),
    [frames]
  );

  const formatId = (f: FrameInfo) => formatFrameId(f.id, displayFrameIdFormat, f.isExtended);

  const anyFrames = sortedFrames.length > 0;
  const buses = useMemo(() => {
    const set = new Set<number>();
    frames.forEach((f) => {
      if (typeof f.bus === "number") set.add(f.bus);
    });
    return Array.from(set).sort((a, b) => a - b);
  }, [frames]);

  const selectedCount = useMemo(
    () => sortedFrames.filter((f) => selected.has(f.id)).length,
    [sortedFrames, selected]
  );

  // Compute warnings for the collapsed header
  const warnings = useMemo(() => {
    const result: FrameWarning[] = [];

    // Check for length mismatches
    const lengthMismatchCount = frames.filter((f) => f.lenMismatch).length;
    if (lengthMismatchCount > 0) {
      result.push({
        type: "length-mismatch",
        count: lengthMismatchCount,
        message: `${lengthMismatchCount} frame${lengthMismatchCount !== 1 ? "s" : ""} with varying payload lengths`,
      });
    }

    return result;
  }, [frames]);

  const hasWarnings = warnings.length > 0;
  const warningTooltip = warnings.map((w) => w.message).join("\n");

  const [isExpanded, setIsExpanded] = useState(defaultExpanded);

  // Determine save icon color based on active set and dirty state
  const getSaveIconColor = () => {
    if (activeSelectionSetId && selectionSetDirty) {
      return "#b91c1c"; // solid red-700 for dirty
    }
    return undefined; // Default color otherwise
  };

  const getSaveIconTitle = () => {
    if (!activeSelectionSetId) {
      return "Save as selection set";
    }
    return selectionSetDirty ? "Save changes to selection set" : "Selection set saved";
  };

  return (
    <div className="space-y-2">
      {/* Header */}
      <button
        type="button"
        onClick={() => setIsExpanded(!isExpanded)}
        className="flex items-center gap-1 w-full text-left"
      >
        {isExpanded ? (
          <ChevronDown className={`${iconSm} text-[color:var(--text-muted)]`} />
        ) : (
          <ChevronRight className={`${iconSm} text-[color:var(--text-muted)]`} />
        )}
        <span className={labelSmall}>
          Frames
        </span>
        <span className={`${captionMuted} ml-1`}>
          ({selectedCount}/{sortedFrames.length})
        </span>
        <div className="flex items-center gap-1 ml-auto">
          {hasWarnings && (
            <span title={warningTooltip} className="text-[color:var(--text-orange)]">
              <AlertTriangle className={iconSm} />
            </span>
          )}
          {actions}
        </div>
      </button>

      {isExpanded && (
        <div className="space-y-2">
          {/* Global All/None icons + Selection Set icons */}
          {(onSelectAll || onDeselectAll || onSaveSelectionSet || onOpenSelectionSetPicker) && (
            <div className="flex flex-wrap gap-1">
              <div className="flex items-center gap-0.5">
                {onSelectAll && (
                  <button
                    type="button"
                    onClick={onSelectAll}
                    disabled={!anyFrames}
                    className={`p-1 rounded ${
                      !anyFrames
                        ? "text-[color:var(--text-muted)] cursor-not-allowed"
                        : `text-[color:var(--text-green)] ${hoverLight}`
                    }`}
                    title="Select all frames"
                  >
                    <CheckCheck className={iconSm} />
                  </button>
                )}
                {onDeselectAll && (
                  <button
                    type="button"
                    onClick={onDeselectAll}
                    disabled={!anyFrames}
                    className={`p-1 rounded ${
                      !anyFrames
                        ? "text-[color:var(--text-muted)] cursor-not-allowed"
                        : `text-[color:var(--text-muted)] ${hoverLight}`
                    }`}
                    title="Deselect all frames"
                  >
                    <SquareSlash className={iconSm} />
                  </button>
                )}
                {/* Save Selection Set Icon */}
                {onSaveSelectionSet && (
                  <button
                    type="button"
                    onClick={onSaveSelectionSet}
                    disabled={!anyFrames && !activeSelectionSetId}
                    className={`p-1 rounded ${
                      !anyFrames && !activeSelectionSetId
                        ? "text-[color:var(--text-muted)] cursor-not-allowed"
                        : hoverLight
                    }`}
                    style={{ color: getSaveIconColor() }}
                    title={getSaveIconTitle()}
                  >
                    <Save className={iconSm} />
                  </button>
                )}
                {/* Selection Set Picker Icon */}
                {onOpenSelectionSetPicker && (
                  <button
                    type="button"
                    onClick={onOpenSelectionSetPicker}
                    className={`p-1 rounded ${hoverLight}`}
                    style={{ color: activeSelectionSetId ? "#eab308" : undefined }}
                    title={activeSelectionSetId ? "Selection set loaded" : "Load selection set"}
                  >
                    <Star
                      className={iconSm}
                      fill={activeSelectionSetId ? "currentColor" : "none"}
                    />
                  </button>
                )}
              </div>
            </div>
          )}
          {/* Per-bus bulk select buttons */}
          {buses.length > 0 && (
            <div className="space-y-1">
              <div className="flex flex-wrap gap-1">
                {buses.map((bus) => (
                  <div key={bus} className="flex items-center gap-0.5 text-[10px]">
                    <span className="px-1.5 py-0.5 rounded bg-[var(--bg-surface)] border border-[color:var(--border-default)] text-[color:var(--text-secondary)]">
                      Bus {bus}
                    </span>
                    <button
                      type="button"
                      onClick={() => onBulkSelect(bus, true)}
                      className="px-1.5 py-0.5 rounded bg-green-600 text-white hover:bg-green-700"
                    >
                      All
                    </button>
                    <button
                      type="button"
                      onClick={() => onBulkSelect(bus, false)}
                      className="px-1.5 py-0.5 rounded bg-[var(--bg-surface)] text-[color:var(--text-secondary)] hover:brightness-95"
                    >
                      None
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}
          <div className="rounded-lg border border-[color:var(--border-default)] overflow-hidden">
            <div className={`divide-y divide-[color:var(--border-default)] ${noInnerScroll ? "" : "max-h-80 overflow-auto"}`}>
              {sortedFrames.map((f) => (
                <label
                  key={f.id}
                  className={`flex items-center gap-2 px-3 py-1.5 text-xs ${hoverLight} cursor-pointer`}
                  style={{
                    color: f.lenMismatch ? "#f97316" : undefined,
                  }}
                  title={f.lenMismatch ? "Payload length varies across frames" : undefined}
                >
                  <input
                    type="checkbox"
                    checked={selected.has(f.id)}
                    onChange={() => onToggle(f.id)}
                    className="w-3 h-3"
                  />
                  <span className="font-mono">{formatId(f)}</span>
                  <span className="text-[10px] text-[color:var(--text-muted)]">
                    [{f.len}]
                  </span>
                  <span className="text-[10px] text-[color:var(--text-muted)]">
                    {typeof f.bus === "number" ? `bus ${f.bus}` : ""}
                  </span>
                </label>
              ))}
              {!anyFrames && (
                <div className={`px-3 py-4 ${caption}`}>
                  No frames discovered yet.
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// Memoize to prevent re-renders when parent re-renders
export default memo(FramePicker);
