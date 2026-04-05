// src/apps/session-manager/nodes/SessionNode.tsx

import { memo } from "react";
import { Handle, Position } from "@xyflow/react";
import { Radio, Pause, Square, AlertCircle, Users, Database } from "lucide-react";
import type { ActiveSessionInfo } from "../../../api/io";
import { iconSm, iconXs } from "../../../styles/spacing";

export interface SessionNodeData {
  session: ActiveSessionInfo;
  label: string;
  /** Input bus numbers (one per enabled source mapping) */
  inputBuses?: number[];
  /** Disabled input bus numbers available for reconnection */
  disabledInputBuses?: number[];
  /** Listener IDs connected to this session (drives output handles) */
  connectedListenerIds?: string[];
}

interface SessionNodeProps {
  data: SessionNodeData;
  selected: boolean;
}

function SessionNode({ data, selected }: SessionNodeProps) {
  const { session, label, inputBuses, disabledInputBuses, connectedListenerIds } = data;

  // Build input bus list: enabled + disabled + one extra empty handle
  const allInputBuses = [
    ...(inputBuses ?? []).map((bus) => ({ bus, enabled: true })),
    ...(disabledInputBuses ?? []).map((bus) => ({ bus, enabled: false })),
  ].sort((a, b) => a.bus - b.bus);

  const nextInputBus = allInputBuses.length > 0
    ? Math.max(...allInputBuses.map((b) => b.bus)) + 1
    : 0;

  // Output handles: one per connected listener + one extra empty
  const listenerIds = connectedListenerIds ?? [];
  const outputCount = listenerIds.length;

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

  const totalOutputHandles = outputCount + 1; // connected + one empty slot

  return (
    <div
      className={`px-4 py-3 rounded-lg border-2 ${borderColour} ${bgColour} min-w-[180px] shadow-lg`}
    >
      {/* Output handles on the right edge (same style as app input handle) */}
      {Array.from({ length: totalOutputHandles }, (_, i) => (
        <Handle
          key={`out-${i}`}
          id={`out-${i}`}
          type="source"
          position={Position.Right}
          className={
            i < outputCount
              ? "!w-3 !h-3 !bg-green-500 !border-2 !border-green-300"
              : "!w-3 !h-3 !bg-green-800 !border-2 !border-dashed !border-green-600 !opacity-40"
          }
          style={{ top: `${((i + 1) / (totalOutputHandles + 1)) * 100}%` }}
        />
      ))}

      {/* Main content with input handle column */}
      <div className="flex gap-3">
        {/* Input bus handles (left column) */}
        <div className="flex flex-col gap-1 justify-center">
          {allInputBuses.map(({ bus, enabled }) => (
            <div key={bus} className="flex items-center gap-1.5 relative">
              <Handle
                id={`in-bus${bus}`}
                type="target"
                position={Position.Left}
                className={
                  enabled
                    ? "!w-3 !h-3 !bg-cyan-500 !border-2 !border-cyan-300 !relative !transform-none !top-0 !left-0"
                    : "!w-3 !h-3 !bg-gray-600 !border-2 !border-gray-500 !border-dashed !opacity-50 !relative !transform-none !top-0 !left-0"
                }
              />
              <span
                className={`text-[10px] font-mono ${
                  enabled ? "text-cyan-400" : "text-gray-500 opacity-50"
                }`}
              >
                {bus}
              </span>
            </div>
          ))}
          {/* Extra empty handle for new connections */}
          <div className="flex items-center gap-1.5 relative">
            <Handle
              id={`in-bus${nextInputBus}`}
              type="target"
              position={Position.Left}
              className="!w-3 !h-3 !bg-cyan-800 !border-2 !border-dashed !border-cyan-600 !opacity-40 !relative !transform-none !top-0 !left-0"
            />
            <span className="text-[10px] font-mono text-gray-600 opacity-40">
              {nextInputBus}
            </span>
          </div>
        </div>

        {/* Centre content */}
        <div className="flex-1 min-w-0">
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
                {session.listenerCount} app{session.listenerCount !== 1 ? "s" : ""}
              </span>
            </div>
            {session.captureFrameCount !== null && session.captureFrameCount > 0 && (
              <div>
                {session.captureFrameCount.toLocaleString()} frames buffered
              </div>
            )}
            <div className="text-[10px] opacity-70">{session.deviceType === "buffer" ? "sqlite" : session.deviceType}</div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default memo(SessionNode);
