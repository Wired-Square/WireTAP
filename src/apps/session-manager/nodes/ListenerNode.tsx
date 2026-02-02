// src/apps/session-manager/nodes/ListenerNode.tsx

import { memo } from "react";
import { Handle, Position } from "@xyflow/react";
import { Search, Activity, Send, FileText, Calculator, DatabaseZap, Settings } from "lucide-react";
import { iconSm } from "../../../styles/spacing";

export interface ListenerNodeData {
  listenerId: string;
  appName: string;
  sessionId: string;
  isOwner: boolean;
}

// Map app names to icons and colours
const appConfig: Record<string, { icon: typeof Search; colour: string }> = {
  discovery: { icon: Search, colour: "text-purple-400" },
  decoder: { icon: Activity, colour: "text-green-400" },
  transmit: { icon: Send, colour: "text-red-400" },
  "catalog-editor": { icon: FileText, colour: "text-blue-400" },
  "frame-calculator": { icon: Calculator, colour: "text-teal-400" },
  query: { icon: DatabaseZap, colour: "text-amber-400" },
  settings: { icon: Settings, colour: "text-orange-400" },
};

interface ListenerNodeProps {
  data: ListenerNodeData;
  selected: boolean;
}

function ListenerNode({ data, selected }: ListenerNodeProps) {
  const { listenerId, appName, isOwner } = data;

  const config = appConfig[appName.toLowerCase()] || {
    icon: Search,
    colour: "text-gray-400",
  };
  const Icon = config.icon;

  const borderColour = selected
    ? "border-cyan-400"
    : isOwner
    ? "border-green-500"
    : "border-[color:var(--border-default)]";

  const bgColour = isOwner
    ? "bg-green-500/10"
    : "bg-[var(--bg-surface)]";

  // Format display name from listener ID
  const displayName = listenerId.includes("-")
    ? listenerId.split("-").slice(0, 2).join("-")
    : listenerId;

  return (
    <div
      className={`px-4 py-3 rounded-lg border-2 ${borderColour} ${bgColour} min-w-[120px] shadow-lg`}
    >
      {/* Input handle - connects from sessions */}
      <Handle
        type="target"
        position={Position.Left}
        className="!w-3 !h-3 !bg-green-500 !border-2 !border-green-300"
      />

      {/* Header */}
      <div className="flex items-center gap-2 mb-1">
        <Icon className={`${iconSm} ${config.colour}`} />
        <span className="font-medium text-sm text-[color:var(--text-primary)] truncate">
          {displayName}
        </span>
      </div>

      {/* Role */}
      <div className="text-xs text-[color:var(--text-muted)]">
        {isOwner ? (
          <span className="text-green-400">Owner</span>
        ) : (
          <span>Listener</span>
        )}
      </div>
    </div>
  );
}

export default memo(ListenerNode);
