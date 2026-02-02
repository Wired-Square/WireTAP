// src/apps/session-manager/nodes/SourceNode.tsx

import { memo } from "react";
import { Handle, Position } from "@xyflow/react";
import { Wifi, Database, Radio } from "lucide-react";
import { iconSm } from "../../../styles/spacing";

export interface SourceNodeData {
  profileId: string;
  profileName: string;
  deviceType: string;
  isRealtime: boolean;
  isActive: boolean;
}

interface SourceNodeProps {
  data: SourceNodeData;
  selected: boolean;
}

function SourceNode({ data, selected }: SourceNodeProps) {
  const { profileName, deviceType, isRealtime, isActive } = data;

  const borderColour = selected
    ? "border-cyan-400"
    : isActive
    ? "border-purple-500"
    : "border-[color:var(--border-default)]";

  const bgColour = isActive
    ? "bg-purple-500/10"
    : "bg-[var(--bg-surface)]";

  const Icon = isRealtime ? Wifi : Database;
  const iconColour = isRealtime ? "text-purple-400" : "text-green-400";

  return (
    <div
      className={`px-4 py-3 rounded-lg border-2 ${borderColour} ${bgColour} min-w-[140px] shadow-lg`}
    >
      {/* Header */}
      <div className="flex items-center gap-2 mb-1">
        <Icon className={`${iconSm} ${iconColour}`} />
        <span className="font-medium text-sm text-[color:var(--text-primary)] truncate">
          {profileName}
        </span>
      </div>

      {/* Device type */}
      <div className="text-xs text-[color:var(--text-muted)] flex items-center gap-1">
        <span>{deviceType}</span>
        {isActive && (
          <Radio className="w-3 h-3 text-purple-500 animate-pulse" />
        )}
      </div>

      {/* Output handle - connects to sessions */}
      <Handle
        type="source"
        position={Position.Right}
        className="!w-3 !h-3 !bg-purple-500 !border-2 !border-purple-300"
      />
    </div>
  );
}

export default memo(SourceNode);
