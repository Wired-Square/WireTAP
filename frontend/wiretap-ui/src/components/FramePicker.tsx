// ui/src/components/FramePicker.tsx

import { useMemo, memo, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronRight, AlertTriangle, Save, Star, CheckCheck, SquareSlash } from "lucide-react";
import { iconSm } from "../styles/spacing";
import { labelSmall, captionMuted, emptyStateText } from "../styles/typography";
import { hoverLight } from "../styles";
import { formatProtocolFrameId } from "../utils/frameIds";
import { protocolLabel } from "../utils/profileTraits";
import { useFrameIdFormat } from "../hooks/useFrameIdFormat";
import { parseFrameKey } from "../utils/frameKey";
import type { FrameInfo } from "../types/common";
import type { SelectionSet } from "../utils/selectionSets";
import { Button, IconButton } from "./Button";
import { Select, Checkbox } from "./forms";

type FrameWarning = {
  type: "length-mismatch";
  count: number;
  message: string;
};

type Props = {
  frames: FrameInfo[];
  selected: Set<string>;
  onToggle: (id: string) => void;
  onBulkSelect: (bus: number | null, select: boolean) => void;
  actions?: React.ReactNode;
  onSelectAll?: () => void;
  onDeselectAll?: () => void;
  // Selection set props
  activeSelectionSetId?: string | null;
  selectionSetDirty?: boolean;
  onSaveSelectionSet?: () => void;
  /** Available selection sets for the dropdown */
  selectionSets?: SelectionSet[];
  /** Called when a selection set is chosen from the dropdown */
  onLoadSelectionSet?: (selectionSet: SelectionSet) => void;
  /** Called when the dropdown is set to "None" */
  onClearSelectionSet?: () => void;
  /** Called when the star icon is clicked to save as a new set */
  onSaveAsNewSelectionSet?: () => void;
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
  actions,
  onSelectAll,
  onDeselectAll,
  activeSelectionSetId,
  selectionSetDirty,
  onSaveSelectionSet,
  selectionSets,
  onLoadSelectionSet,
  onClearSelectionSet,
  onSaveAsNewSelectionSet,
  defaultExpanded = false,
  noInnerScroll = false,
}: Props) {
  const { t } = useTranslation("common");
  const { effective: displayFrameIdFormat } = useFrameIdFormat();
  const sortedFrames = useMemo(
    () => [...frames].sort((a, b) => {
      const aId = parseFrameKey(a.id).frameId;
      const bId = parseFrameKey(b.id).frameId;
      return aId - bId;
    }),
    [frames]
  );

  const formatId = (f: FrameInfo) =>
    formatProtocolFrameId(f.protocol, parseFrameKey(f.id).frameId, displayFrameIdFormat, f.isExtended);

  const anyFrames = sortedFrames.length > 0;
  const buses = useMemo(() => {
    const set = new Set<number>();
    frames.forEach((f) => {
      if (typeof f.bus === "number") set.add(f.bus);
    });
    return Array.from(set).sort((a, b) => a - b);
  }, [frames]);

  // Show protocol badges when multiple protocols are present
  const protocols = useMemo(() => {
    const set = new Set<string>();
    frames.forEach((f) => {
      if (f.protocol) set.add(f.protocol);
    });
    return set;
  }, [frames]);
  const isMultiProtocol = protocols.size > 1;

  const hasBuslessFrames = useMemo(
    () => frames.some((f) => typeof f.bus !== "number"),
    [frames]
  );

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

  // Save icon: only active when there's an active set with unsaved changes
  const saveDisabled = !activeSelectionSetId || !selectionSetDirty;

  const getSaveIconColor = () => {
    if (activeSelectionSetId && selectionSetDirty) {
      return "#b91c1c"; // solid red-700 for dirty
    }
    return undefined;
  };

  const getSaveIconTitle = () => {
    if (!activeSelectionSetId) {
      return "No selection set active";
    }
    return selectionSetDirty ? "Save changes to selection set" : "No unsaved changes";
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
          {/* Global All/None icons + Selection Set controls */}
          {(onSelectAll || onDeselectAll || onSaveSelectionSet || selectionSets) && (
            <div className="flex flex-wrap items-center gap-1">
              <div className="flex items-center gap-0.5">
                {onSelectAll && (
                  <IconButton
                    onClick={onSelectAll}
                    disabled={!anyFrames}
                    tone="success"
                    size="sm"
                    title={t("framePicker.selectAll")}
                  >
                    <CheckCheck className={iconSm} />
                  </IconButton>
                )}
                {onDeselectAll && (
                  <IconButton
                    onClick={onDeselectAll}
                    disabled={!anyFrames}
                    size="sm"
                    title={t("framePicker.deselectAll")}
                  >
                    <SquareSlash className={iconSm} />
                  </IconButton>
                )}
                {/* Save to active selection set */}
                {onSaveSelectionSet && (
                  <IconButton
                    onClick={onSaveSelectionSet}
                    disabled={saveDisabled}
                    size="sm"
                    style={{ color: getSaveIconColor() }}
                    title={getSaveIconTitle()}
                  >
                    <Save className={iconSm} />
                  </IconButton>
                )}
                {/* Save as new selection set */}
                {onSaveAsNewSelectionSet && (
                  <IconButton
                    onClick={onSaveAsNewSelectionSet}
                    disabled={!anyFrames}
                    size="sm"
                    title={t("framePicker.saveSelectionSet")}
                  >
                    <Star className={iconSm} />
                  </IconButton>
                )}
              </div>
              {/* Selection set dropdown */}
              {selectionSets && (
                <Select
                  value={activeSelectionSetId ?? ""}
                  onChange={(e) => {
                    const id = e.target.value;
                    if (id === "") {
                      onClearSelectionSet?.();
                    } else {
                      const set = selectionSets.find((s) => s.id === id);
                      if (set) onLoadSelectionSet?.(set);
                    }
                  }}
                  size="xs"
                  className="max-w-[140px] w-auto"
                  title={t("framePicker.selectionSet")}
                >
                  <option value="">-- None --</option>
                  {selectionSets.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </Select>
              )}
            </div>
          )}
          {/* Per-bus bulk select buttons */}
          {(buses.length > 0 || hasBuslessFrames) && (
            <div className="space-y-1">
              <div className="flex flex-wrap gap-1">
                {buses.map((bus) => (
                  <div key={bus} className="flex items-center gap-0.5 text-[10px]">
                    <span className="px-1.5 py-0.5 rounded bg-[var(--bg-surface)] border border-[color:var(--border-default)] text-[color:var(--text-secondary)]">
                      Bus {bus}
                    </span>
                    <Button
                      onClick={() => onBulkSelect(bus, true)}
                      variant="solid"
                      tone="success"
                      size="sm"
                    >
                      All
                    </Button>
                    <Button
                      onClick={() => onBulkSelect(bus, false)}
                      size="sm"
                    >
                      None
                    </Button>
                  </div>
                ))}
                {hasBuslessFrames && (
                  <div className="flex items-center gap-0.5 text-[10px]">
                    <span className="px-1.5 py-0.5 rounded bg-[var(--bg-surface)] border border-[color:var(--border-default)] text-[color:var(--text-muted)] italic">
                      No bus
                    </span>
                    <Button
                      onClick={() => onBulkSelect(null, true)}
                      variant="solid"
                      tone="success"
                      size="sm"
                    >
                      All
                    </Button>
                    <Button
                      onClick={() => onBulkSelect(null, false)}
                      size="sm"
                    >
                      None
                    </Button>
                  </div>
                )}
              </div>
            </div>
          )}
          <div className="rounded-lg border border-[color:var(--border-default)] overflow-hidden">
            <div className={`divide-y divide-[color:var(--border-default)] ${noInnerScroll ? "" : "max-h-80 overflow-auto"}`}>
              {sortedFrames.map((f) => (
                <label
                  key={f.id}
                  className={`flex flex-col gap-0.5 px-3 py-1.5 text-xs ${hoverLight} cursor-pointer`}
                  style={{
                    color: f.lenMismatch ? "#f97316" : undefined,
                  }}
                  title={f.lenMismatch ? "Payload length varies across frames" : undefined}
                >
                  <span className="flex items-center gap-2">
                    <Checkbox
                      checked={selected.has(f.id)}
                      onChange={() => onToggle(f.id)}
                      size="sm"
                    />
                    <span className="font-mono">{formatId(f)}</span>
                    <span className="text-[10px] text-[color:var(--text-muted)]">
                      [{f.len}]
                    </span>
                    {typeof f.bus === "number" && (
                      <span className="text-[10px] text-[color:var(--text-muted)]">
                        bus {f.bus}
                      </span>
                    )}
                    {isMultiProtocol && f.protocol && (
                      <span className={`text-[9px] px-1 py-0.5 rounded font-medium ${
                        f.protocol === 'modbus' || f.protocol === 'modbus_rtu' ? 'bg-amber-500/15 text-[color:var(--text-amber)]' :
                        f.protocol === 'serial' ? 'bg-purple-500/15 text-[color:var(--text-purple)]' :
                        'bg-blue-500/15 text-[color:var(--text-blue)]'
                      }`}>
                        {protocolLabel(f.protocol)}
                      </span>
                    )}
                  </span>
                  {f.detail && (
                    <span className="pl-5 text-[10px] text-[color:var(--text-muted)] font-mono leading-snug">
                      {f.detail}
                    </span>
                  )}
                </label>
              ))}
              {!anyFrames && (
                <div className={`px-3 py-4 ${emptyStateText}`}>
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
