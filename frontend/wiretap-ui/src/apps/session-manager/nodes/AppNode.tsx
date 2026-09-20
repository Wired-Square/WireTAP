// src/apps/session-manager/nodes/AppNode.tsx

import { memo } from "react";
import { Handle, Position } from "@xyflow/react";
import { iconSm } from "../../../styles/spacing";
import { isPanelId } from "../../../apps/registry";
import { AppIcon } from "../../../components/AppIcon";

export interface AppNodeData {
  appId: string;
  appName: string;
  sessionId?: string;
  isActive: boolean;
  isConnected: boolean;
  registeredSecondsAgo?: number;
}

interface AppNodeProps {
  data: AppNodeData;
  selected: boolean;
}

function AppNode({ data, selected }: AppNodeProps) {
  const { appId, appName, isActive } = data;

  const borderColour = selected
    ? "border-cyan-400"
    : data.isConnected
    ? "border-[color:var(--border-default)]"
    : "border-dashed border-[color:var(--border-default)]";

  const bgColour = "bg-[var(--bg-surface)]";

  // Show the cosmetic per-instance id (e.g. "decoder_a3f9").
  const displayName = appId;

  return (
    <div
      className={`px-4 py-3 rounded-lg border-2 ${borderColour} ${bgColour} min-w-[120px] shadow-lg ${!data.isConnected ? "opacity-40" : isActive ? "" : "opacity-50"}`}
    >
      {/* Input handle - connects from sessions */}
      <Handle
        type="target"
        position={Position.Left}
        className="!w-3 !h-3 !bg-green-500 !border-2 !border-green-300"
      />

      {/* Header */}
      <div className="flex items-center gap-2 mb-1">
        <AppIcon app={isPanelId(appName) ? appName : null} className={iconSm} />
        <span className="font-medium text-sm text-[color:var(--text-primary)] truncate">
          {displayName}
        </span>
        <span className={`inline-block w-2 h-2 rounded-full flex-shrink-0 ${isActive ? "bg-green-400" : "bg-gray-500"}`} />
      </div>

    </div>
  );
}

export default memo(AppNode);
