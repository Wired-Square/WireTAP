// src/apps/session-manager/nodes/SourceNode.tsx

import { memo } from "react";
import { useTranslation } from "react-i18next";
import { Handle, Position } from "@xyflow/react";
import { Wifi, Database, Radio, Pin } from "lucide-react";
import { iconSm, iconXs } from "../../../styles/spacing";
import { textDataPurple, textDataDisabled, sourceKindColours } from "../../../styles/colourTokens";

export interface SourceNodeData {
  profileId: string;
  profileName: string;
  sourceType: string;
  isRealtime: boolean;
  isActive: boolean;
  /** Device bus numbers this source outputs (one handle per bus) */
  outputBuses?: number[];
  /** Device bus numbers with disabled mappings (shown as muted handles) */
  disabledBuses?: number[];
  /** Buffer display name (when source is a buffer) */
  captureName?: string;
  /** Whether this buffer is pinned (persistent across restarts) */
  isPersistent?: boolean;
  /** Number of items in the buffer */
  captureCount?: number;
  /** Buffer data type ("frames" or "bytes") */
  captureKind?: string;
}

interface SourceNodeProps {
  data: SourceNodeData;
  selected: boolean;
}

function SourceNode({ data, selected }: SourceNodeProps) {
  const { t } = useTranslation("sessionManager");
  const { profileName, sourceType, isRealtime, isActive, outputBuses, disabledBuses, captureName, isPersistent, captureCount, captureKind } = data;
  // Merge enabled + disabled buses for handle layout (disabled shown as muted)
  const allBuses = [
    ...(outputBuses ?? []).map((b) => ({ bus: b, enabled: true })),
    ...(disabledBuses ?? []).map((b) => ({ bus: b, enabled: false })),
  ].sort((a, b) => a.bus - b.bus);

  const borderColour = selected
    ? "border-text-cyan"
    : isActive
    ? "border-text-purple"
    : "border-default";

  const bgColour = isActive
    ? "bg-purple"
    : "bg-surface";

  const kind = sourceType === "sqlite" ? "capture" : isRealtime ? "realtime" : "recorded";
  const Icon = isRealtime ? Wifi : Database;
  const iconColour = sourceKindColours[kind].text;

  return (
    <div
      className={`px-4 py-3 rounded-lg border-2 ${borderColour} ${bgColour} min-w-35 shadow-lg`}
    >
      {/* Header */}
      <div className="flex items-center gap-2 mb-1">
        <Icon className={`${iconSm} ${iconColour}`} />
        <span className="font-medium text-sm text-primary truncate">
          {captureName || profileName}
        </span>
        {isPersistent && (
          <Pin className={`${iconXs} text-amber flex-shrink-0`} />
        )}
      </div>

      {/* Device type + buffer info */}
      <div className="text-xs text-muted flex items-center gap-1">
        <span>{sourceType}</span>
        {isActive && (
          <Radio className="w-3 h-3 text-purple animate-pulse" />
        )}
      </div>
      {captureCount != null && (
        <div className="text-2xs text-muted mt-0.5">
          {captureCount.toLocaleString()} {captureKind ?? "frames"}
        </div>
      )}

      {/* Bus handles with labels */}
      {allBuses.length > 0 ? (
        <div className="mt-2 flex flex-col gap-1">
          {allBuses.map(({ bus, enabled }) => (
            <div
              key={bus}
              className="flex items-center justify-end gap-1.5 relative"
              title={enabled ? undefined : t("node.source.unwiredBus", { bus })}
            >
              <span
                className={`text-2xs font-mono ${
                  enabled ? textDataPurple : textDataDisabled
                }`}
              >
                bus{bus}
              </span>
              <Handle
                id={`out-bus${bus}`}
                type="source"
                position={Position.Right}
                className={
                  enabled
                    ? "!w-3 !h-3 !bg-text-purple !border-2 !border-purple !relative !transform-none !top-0 !right-0"
                    : "!w-3 !h-3 !bg-tertiary !border-2 !border-text-muted !border-dashed !opacity-50 !relative !transform-none !top-0 !right-0"
                }
              />
            </div>
          ))}
        </div>
      ) : (
        <Handle
          type="source"
          position={Position.Right}
          className="!w-3 !h-3 !bg-text-purple !border-2 !border-purple"
        />
      )}
    </div>
  );
}

export default memo(SourceNode);
