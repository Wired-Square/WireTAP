// src/components/ProtocolBadge.tsx
//
// Shared protocol badge component showing streaming status, protocol label,
// and optional recorded indicator. Used in Decoder, Discovery, and Transmit top bars.

import { History } from "lucide-react";
import { iconXs } from "../styles/spacing";
import { textDataSecondary } from "../styles";

// ============================================================================
// Types
// ============================================================================

export type StreamingStatus = "stopped" | "live" | "paused";

export interface ProtocolBadgeProps {
  /** Protocol or mode label (e.g., "CAN", "Serial"). Used as fallback if capabilities not provided. */
  label?: string;
  /** Whether the device supports CAN transmission. If true, shows "CAN" label. */
  canTransmit?: boolean;
  /** Whether the device supports serial transmission. If true and canTransmit is false, shows "Serial" label. */
  canTransmitSerial?: boolean;
  /** Streaming status: 'stopped' (red), 'live' (green), or 'paused' (orange) */
  status?: StreamingStatus;
  /** @deprecated Use status instead. Whether data is currently streaming */
  isStreaming?: boolean;
  /** Whether the data source is recorded (e.g., PostgreSQL, CSV) vs live */
  isRecorded?: boolean;
  /** Called when the badge is clicked (for future functionality) */
  onClick?: () => void;
}

// ============================================================================
// Status Light Component
// ============================================================================

function StatusLight({ status }: { status: StreamingStatus }) {
  const colorClass =
    status === "live"
      ? "bg-green-500"
      : status === "paused"
        ? "bg-orange-500"
        : "bg-red-500";

  return (
    <span
      className={`w-2 h-2 rounded-full ${colorClass}`}
      title={
        status === "live" ? "Live" : status === "paused" ? "Paused" : "Stopped"
      }
    />
  );
}

// ============================================================================
// Component
// ============================================================================

export default function ProtocolBadge({
  label,
  canTransmit,
  canTransmitSerial,
  status,
  isStreaming,
  isRecorded = false,
  onClick,
}: ProtocolBadgeProps) {
  // Support both new status prop and legacy isStreaming prop
  const effectiveStatus: StreamingStatus =
    status ?? (isStreaming ? "live" : "stopped");

  // Determine label from capabilities if provided, otherwise use label prop
  const effectiveLabel = canTransmit
    ? "CAN"
    : canTransmitSerial
      ? "Serial"
      : label ?? "CAN";

  return (
    <button
      onClick={onClick}
      disabled={!onClick}
      className={`flex items-center gap-1.5 px-2 py-1 rounded bg-gray-700/50 ${
        onClick ? "hover:bg-gray-600/50 cursor-pointer" : "cursor-default"
      }`}
      title={isRecorded ? "Recorded data source" : "Live data source"}
    >
      <StatusLight status={effectiveStatus} />
      <span className="text-xs font-medium text-gray-300">{effectiveLabel}</span>
      {isRecorded && <History className={`${iconXs} ${textDataSecondary}`} />}
    </button>
  );
}
