// src/components/ProtocolBadge.tsx
//
// Shared protocol badge showing streaming status, protocol label and an
// optional recorded indicator. Used in Decoder, Discovery, and Transmit top bars.

import { History } from "lucide-react";
import { useTranslation } from "react-i18next";
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

const LIGHT_COLOURS: Record<StreamingStatus, string> = {
  live: "bg-accent-success",
  paused: "bg-accent-warning",
  stopped: "bg-accent-danger",
};

export default function ProtocolBadge({
  label,
  status,
  isStreaming,
  isRecorded = false,
}: ProtocolBadgeProps) {
  const { t } = useTranslation("common");
  const light = status ?? (isStreaming ? "live" : "stopped");

  return (
    <Badge size="lg" className="gap-1.5" title={isRecorded ? t("dataSource.recorded") : t("dataSource.live")}>
      <span className={`w-2 h-2 rounded-full ${LIGHT_COLOURS[light]}`} title={t(`status.${light}`)} />
      {label ?? "—"}
      {isRecorded && <History className={iconXs} />}
    </Badge>
  );
}
