// src/components/ProtocolBadge.tsx
//
// Shared protocol badge showing streaming status, protocol label and an
// optional recorded indicator. Used in Decoder, Discovery, and Transmit top bars.

import { History } from "lucide-react";
import { iconXs } from "../styles/spacing";
import { Badge } from "./Badge";

export type StreamingStatus = "stopped" | "live" | "paused";

export interface ProtocolBadgeProps {
  /** Protocol or mode label (e.g., "CAN", "Serial") */
  label?: string;
  /** Streaming status: 'stopped' (red), 'live' (green), or 'paused' (orange) */
  status?: StreamingStatus;
  /** @deprecated Use status instead. Whether data is currently streaming */
  isStreaming?: boolean;
  /** Whether the data source is recorded (e.g., WireTAP backend, CSV) vs live */
  isRecorded?: boolean;
}

const LIGHT: Record<StreamingStatus, { colour: string; title: string }> = {
  live: { colour: "bg-accent-success", title: "Live" },
  paused: { colour: "bg-accent-warning", title: "Paused" },
  stopped: { colour: "bg-accent-danger", title: "Stopped" },
};

export default function ProtocolBadge({
  label,
  status,
  isStreaming,
  isRecorded = false,
}: ProtocolBadgeProps) {
  const light = LIGHT[status ?? (isStreaming ? "live" : "stopped")];

  return (
    <Badge size="lg" className="gap-1.5" title={isRecorded ? "Recorded data source" : "Live data source"}>
      <span className={`w-2 h-2 rounded-full ${light.colour}`} title={light.title} />
      {label ?? "—"}
      {isRecorded && <History className={iconXs} />}
    </Badge>
  );
}
