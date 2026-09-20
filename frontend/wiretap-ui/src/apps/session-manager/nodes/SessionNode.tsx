// src/apps/session-manager/nodes/SessionNode.tsx

import { memo } from "react";
import { useTranslation } from "react-i18next";
import { Handle, Position } from "@xyflow/react";
import { Radio, Pause, Square, AlertCircle, Users, Database } from "lucide-react";
import type { ActiveSessionInfo } from "../../../api/io";
import { iconSm, iconXs } from "../../../styles/spacing";
import { textDataCyan, textDataDisabled, textMuted } from "../../../styles/colourTokens";

export interface SessionNodeData {
  session: ActiveSessionInfo;
  label: string;
  /** Input bus numbers (one per enabled source mapping) */
  inputBuses?: number[];
  /** Disabled input bus numbers available for reconnection */
  disabledInputBuses?: number[];
  /** Listener IDs connected to this session (drives output handles) */
  connectedSubscriberIds?: string[];
}

interface SessionNodeProps {
  data: SessionNodeData;
  selected: boolean;
}

function SessionNode({ data, selected }: SessionNodeProps) {
  const { t } = useTranslation("sessionManager");
  const { session, label, inputBuses, disabledInputBuses, connectedSubscriberIds } = data;

  // Build input bus list: enabled + disabled + one extra empty handle
  const allInputBuses = [
    ...(inputBuses ?? []).map((bus) => ({ bus, enabled: true })),
    ...(disabledInputBuses ?? []).map((bus) => ({ bus, enabled: false })),
  ].sort((a, b) => a.bus - b.bus);

  const nextInputBus = allInputBuses.length > 0
    ? Math.max(...allInputBuses.map((b) => b.bus)) + 1
    : 0;

  // Output handles: one per connected listener + one extra empty
  const subscriberIds = connectedSubscriberIds ?? [];
  const outputCount = subscriberIds.length;

  const isRunning = session.state === "running";
  const isStopped = session.state === "stopped";
  const isPaused = session.state === "paused";
  const isError = session.state === "error";

  // Determine colours based on state
  const borderColour = selected
    ? "border-text-cyan"
    : isRunning
    ? "border-success-text"
    : isStopped
    ? "border-warning-text"
    : isPaused
    ? "border-info-text"
    : isError
    ? "border-danger-text"
    : "border-default";

  const bgColour = isRunning
    ? "bg-success"
    : isStopped
    ? "bg-warning"
    : isPaused
    ? "bg-info"
    : isError
    ? "bg-danger"
    : "bg-surface";

  const stateIcon = isRunning ? (
    <Radio className={`${iconXs} text-success animate-pulse`} />
  ) : isStopped ? (
    <Square className={`${iconXs} text-warning`} />
  ) : isPaused ? (
    <Pause className={`${iconXs} text-info`} />
  ) : isError ? (
    <AlertCircle className={`${iconXs} text-danger`} />
  ) : null;

  const stateLabel = isRunning
    ? t("node.session.states.running")
    : isStopped
    ? t("node.session.states.stopped")
    : isPaused
    ? t("node.session.states.paused")
    : isError
    ? t("node.session.states.error")
    : session.state;

  const totalOutputHandles = outputCount + 1; // connected + one empty slot

  return (
    <div
      className={`px-4 py-3 rounded-lg border-2 ${borderColour} ${bgColour} min-w-45 shadow-lg`}
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
              ? "!w-3 !h-3 !bg-text-green !border-2 !border-success"
              : "!w-3 !h-3 !bg-success !border-2 !border-dashed !border-text-green !opacity-40"
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
                    ? "!w-3 !h-3 !bg-text-cyan !border-2 !border-cyan !relative !transform-none !top-0 !left-0"
                    : "!w-3 !h-3 !bg-tertiary !border-2 !border-text-muted !border-dashed !opacity-50 !relative !transform-none !top-0 !left-0"
                }
              />
              <span
                className={`text-2xs font-mono ${
                  enabled ? textDataCyan : textDataDisabled
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
              className="!w-3 !h-3 !bg-cyan !border-2 !border-dashed !border-text-cyan !opacity-40 !relative !transform-none !top-0 !left-0"
            />
            <span className={`text-2xs font-mono ${textMuted} opacity-40`}>
              {nextInputBus}
            </span>
          </div>
        </div>

        {/* Centre content */}
        <div className="flex-1 min-w-0">
          {/* Header */}
          <div className="flex items-center gap-2 mb-2">
            <Database className={`${iconSm} text-cyan`} />
            <span className="font-medium text-sm text-primary truncate">
              {label}
            </span>
          </div>

          {/* State indicator */}
          <div className="flex items-center gap-2 mb-2">
            {stateIcon}
            <span className="text-xs text-secondary">
              {stateLabel}
            </span>
          </div>

          {/* Details */}
          <div className="space-y-1 text-xs text-muted">
            <div className="flex items-center gap-1">
              <Users className={iconXs} />
              <span>
                {t("node.session.appsCount", { count: session.subscriberCount })}
              </span>
            </div>
            {session.captureFrameCount !== null && session.captureFrameCount > 0 && (
              <div>
                {t("node.session.framesBuffered", { count: session.captureFrameCount })}
              </div>
            )}
            <div className="text-2xs opacity-70">{session.sourceType === "capture" ? "sqlite" : session.sourceType}</div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default memo(SessionNode);
