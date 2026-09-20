// The toggling header the three protocol config sections share: chevron, a
// tinted icon well, the protocol name, its status, and Add / Remove.

import type { ReactNode } from "react";
import { ChevronDown, ChevronRight, AlertTriangle, Check } from "lucide-react";
import { iconMd, iconXs, flexRowGap2 } from "../../../../styles/spacing";
import { Button } from "../../../../components/Button";

type SectionTone = "success" | "purple" | "warning";

const WELL: Record<SectionTone, string> = {
  success: "bg-success text-success",
  purple: "bg-purple text-purple",
  warning: "bg-warning text-warning",
};

export interface ConfigSectionHeaderProps {
  label: string;
  icon: ReactNode;
  tone: SectionTone;
  isConfigured: boolean;
  /** Frames of this protocol exist but no config does */
  showWarning: boolean;
  isExpanded: boolean;
  onToggleExpanded: () => void;
  onAdd: () => void;
  onRemove: () => void;
}

export function ConfigSectionHeader({
  label,
  icon,
  tone,
  isConfigured,
  showWarning,
  isExpanded,
  onToggleExpanded,
  onAdd,
  onRemove,
}: ConfigSectionHeaderProps) {
  const Chevron = isExpanded ? ChevronDown : ChevronRight;
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onToggleExpanded}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") onToggleExpanded(); }}
      className="w-full flex items-center justify-between px-4 py-3 hover:bg-hover transition-colors"
    >
      <div className="flex items-center gap-3">
        <Chevron className={`${iconMd} text-slate-500`} />
        <div className={`p-1.5 rounded ${WELL[tone]}`}>{icon}</div>
        <span className="font-medium text-primary">{label}</span>
        {isConfigured && (
          <span className="flex items-center gap-1 text-xs text-green">
            <Check className={iconXs} />
            configured
          </span>
        )}
        {showWarning && (
          <span className="flex items-center gap-1 text-xs text-amber">
            <AlertTriangle className={iconXs} />
            frames exist, no config
          </span>
        )}
      </div>
      <div className={flexRowGap2} onClick={(e) => e.stopPropagation()}>
        {isConfigured ? (
          <Button onClick={onRemove} variant="ghost" tone="danger" size="sm">
            Remove
          </Button>
        ) : (
          <Button onClick={onAdd} variant="ghost" tone={tone} size="sm">
            + Add
          </Button>
        )}
      </div>
    </div>
  );
}
