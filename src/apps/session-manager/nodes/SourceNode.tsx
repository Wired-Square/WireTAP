// src/apps/session-manager/nodes/SourceNode.tsx

import { memo } from "react";
import { Handle, Position } from "@xyflow/react";
import { Wifi, Database, Radio, Pin } from "lucide-react";
import { iconSm, iconXs } from "../../../styles/spacing";

export interface SourceNodeData {
  profileId: string;
  profileName: string;
  deviceType: string;
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
  const { profileName, deviceType, isRealtime, isActive, outputBuses, disabledBuses, captureName, isPersistent, captureCount, captureKind } = data;
  // Merge enabled + disabled buses for handle layout (disabled shown as muted)
  const allBuses = [
    ...(outputBuses ?? []).map((b) => ({ bus: b, enabled: true })),
    ...(disabledBuses ?? []).map((b) => ({ bus: b, enabled: false })),
  ].sort((a, b) => a.bus - b.bus);

  const borderColour = selected
    ? "border-cyan-400"
    : isActive
    ? "border-purple-500"
    : "border-[color:var(--border-default)]";

  const bgColour = isActive
    ? "bg-purple-500/10"
    : "bg-[var(--bg-surface)]";

  const isBuffer = deviceType === "sqlite";
  const Icon = isRealtime ? Wifi : Database;
  const iconColour = isBuffer ? "text-cyan-400" : isRealtime ? "text-purple-400" : "text-green-400";

  return (
    <div
      className={`px-4 py-3 rounded-lg border-2 ${borderColour} ${bgColour} min-w-[140px] shadow-lg`}
    >
      {/* Header */}
      <div className="flex items-center gap-2 mb-1">
        <Icon className={`${iconSm} ${iconColour}`} />
        <span className="font-medium text-sm text-[color:var(--text-primary)] truncate">
          {captureName || profileName}
        </span>
        {isPersistent && (
          <Pin className={`${iconXs} text-amber-400 flex-shrink-0`} />
        )}
      </div>

      {/* Device type + buffer info */}
      <div className="text-xs text-[color:var(--text-muted)] flex items-center gap-1">
        <span>{deviceType}</span>
        {isActive && (
          <Radio className="w-3 h-3 text-purple-500 animate-pulse" />
        )}
      </div>
      {captureCount != null && (
        <div className="text-[10px] text-[color:var(--text-muted)] mt-0.5">
          {captureCount.toLocaleString()} {captureKind ?? "frames"}
        </div>
      )}

      {/* Bus handles with labels */}
      {allBuses.length > 0 ? (
        <div className="mt-2 flex flex-col gap-1">
          {allBuses.map(({ bus, enabled }) => (
            <div key={bus} className="flex items-center justify-end gap-1.5 relative">
              <span
                className={`text-[10px] font-mono ${
                  enabled ? "text-purple-400" : "text-gray-500 opacity-50"
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
                    ? "!w-3 !h-3 !bg-purple-500 !border-2 !border-purple-300 !relative !transform-none !top-0 !right-0"
                    : "!w-3 !h-3 !bg-gray-600 !border-2 !border-gray-500 !border-dashed !opacity-50 !relative !transform-none !top-0 !right-0"
                }
              />
            </div>
          ))}
        </div>
      ) : (
        <Handle
          type="source"
          position={Position.Right}
          className="!w-3 !h-3 !bg-purple-500 !border-2 !border-purple-300"
        />
      )}
    </div>
  );
}

export default memo(SourceNode);
