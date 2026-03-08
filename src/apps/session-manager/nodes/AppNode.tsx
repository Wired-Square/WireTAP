// src/apps/session-manager/nodes/AppNode.tsx

import { memo } from "react";
import { Handle, Position } from "@xyflow/react";
import { Search, Activity, Send, FileText, Calculator, DatabaseZap, Settings, BarChart3 } from "lucide-react";
import { iconSm } from "../../../styles/spacing";

export interface AppNodeData {
  appId: string;
  appName: string;
  sessionId?: string;
  isActive: boolean;
  isConnected: boolean;
  registeredSecondsAgo?: number;
}

// Map app names to icons and colours
const appConfig: Record<string, { icon: typeof Search; colour: string }> = {
  discovery: { icon: Search, colour: "text-purple-400" },
  decoder: { icon: Activity, colour: "text-green-400" },
  transmit: { icon: Send, colour: "text-red-400" },
  "catalog-editor": { icon: FileText, colour: "text-blue-400" },
  "frame-calculator": { icon: Calculator, colour: "text-teal-400" },
  query: { icon: DatabaseZap, colour: "text-amber-400" },
  graph: { icon: BarChart3, colour: "text-pink-400" },
  settings: { icon: Settings, colour: "text-orange-400" },
};

interface AppNodeProps {
  data: AppNodeData;
  selected: boolean;
}

function AppNode({ data, selected }: AppNodeProps) {
  const { appId, appName, isActive } = data;

  const config = appConfig[appName.toLowerCase()] || {
    icon: Search,
    colour: "text-gray-400",
  };
  const Icon = config.icon;

  const borderColour = selected
    ? "border-cyan-400"
    : data.isConnected
    ? "border-[color:var(--border-default)]"
    : "border-dashed border-[color:var(--border-default)]";

  const bgColour = "bg-[var(--bg-surface)]";

  // Format display name from app ID
  const displayName = appId.includes("-")
    ? appId.split("-").slice(0, 2).join("-")
    : appId;

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
        <Icon className={`${iconSm} ${config.colour}`} />
        <span className="font-medium text-sm text-[color:var(--text-primary)] truncate">
          {displayName}
        </span>
        <span className={`inline-block w-2 h-2 rounded-full flex-shrink-0 ${isActive ? "bg-green-400" : "bg-gray-500"}`} />
      </div>

    </div>
  );
}

export default memo(AppNode);
