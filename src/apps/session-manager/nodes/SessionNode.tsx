// src/apps/session-manager/nodes/SessionNode.tsx

import { memo } from "react";
import { Handle, Position } from "@xyflow/react";
import { Radio, Pause, Square, AlertCircle, Users, Database } from "lucide-react";
import type { ActiveSessionInfo } from "../../../api/io";
import { iconSm, iconXs } from "../../../styles/spacing";

export interface SessionNodeData {
  session: ActiveSessionInfo;
  label: string;
}

interface SessionNodeProps {
  data: SessionNodeData;
  selected: boolean;
}

function SessionNode({ data, selected }: SessionNodeProps) {
  const { session, label } = data;
  const isRunning = session.state === "running";
  const isStopped = session.state === "stopped";
  const isPaused = session.state === "paused";
  const isError = session.state === "error";

  // Determine colours based on state
  const borderColour = selected
    ? "border-cyan-400"
    : isRunning
    ? "border-green-500"
    : isStopped
    ? "border-amber-500"
    : isPaused
    ? "border-blue-500"
    : isError
    ? "border-red-500"
    : "border-[color:var(--border-default)]";

  const bgColour = isRunning
    ? "bg-green-500/10"
    : isStopped
    ? "bg-amber-500/10"
    : isPaused
    ? "bg-blue-500/10"
    : isError
    ? "bg-red-500/10"
    : "bg-[var(--bg-surface)]";

  const stateIcon = isRunning ? (
    <Radio className={`${iconXs} text-green-500 animate-pulse`} />
  ) : isStopped ? (
    <Square className={`${iconXs} text-amber-500`} />
  ) : isPaused ? (
    <Pause className={`${iconXs} text-blue-500`} />
  ) : isError ? (
    <AlertCircle className={`${iconXs} text-red-500`} />
  ) : null;

  const stateLabel = isRunning
    ? "Running"
    : isStopped
    ? "Stopped"
    : isPaused
    ? "Paused"
    : isError
    ? "Error"
    : session.state;

  return (
    <div
      className={`px-4 py-3 rounded-lg border-2 ${borderColour} ${bgColour} min-w-[180px] shadow-lg`}
    >
      {/* Input handle - connects from sources */}
      <Handle
        type="target"
        position={Position.Left}
        className="!w-3 !h-3 !bg-cyan-500 !border-2 !border-cyan-300"
      />

      {/* Header */}
      <div className="flex items-center gap-2 mb-2">
        <Database className={`${iconSm} text-cyan-400`} />
        <span className="font-medium text-sm text-[color:var(--text-primary)] truncate">
          {label}
        </span>
      </div>

      {/* State indicator */}
      <div className="flex items-center gap-2 mb-2">
        {stateIcon}
        <span className="text-xs text-[color:var(--text-secondary)]">
          {stateLabel}
        </span>
      </div>

      {/* Details */}
      <div className="space-y-1 text-xs text-[color:var(--text-muted)]">
        <div className="flex items-center gap-1">
          <Users className={iconXs} />
          <span>
            {session.listenerCount} listener{session.listenerCount !== 1 ? "s" : ""}
          </span>
        </div>
        {session.bufferFrameCount !== null && session.bufferFrameCount > 0 && (
          <div>
            {session.bufferFrameCount.toLocaleString()} frames buffered
          </div>
        )}
        <div className="text-[10px] opacity-70">{session.deviceType}</div>
      </div>

      {/* Output handle - connects to listeners */}
      <Handle
        type="source"
        position={Position.Right}
        className="!w-3 !h-3 !bg-cyan-500 !border-2 !border-cyan-300"
      />
    </div>
  );
}

export default memo(SessionNode);
