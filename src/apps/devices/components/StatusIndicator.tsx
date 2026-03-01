// ui/src/apps/devices/components/StatusIndicator.tsx

import { badgeSuccess, badgeDanger, badgeInfo, badgeNeutral } from "../../../styles";
import {
  STATUS_DISCONNECTED,
  STATUS_CONNECTING,
  STATUS_CONNECTED,
  STATUS_ERROR,
} from "../../../api/bleProvision";

interface StatusIndicatorProps {
  statusCode: number;
}

const statusConfig: Record<number, { label: string; badge: string }> = {
  [STATUS_DISCONNECTED]: { label: "Disconnected", badge: badgeNeutral },
  [STATUS_CONNECTING]: { label: "Connecting", badge: badgeInfo },
  [STATUS_CONNECTED]: { label: "Connected", badge: badgeSuccess },
  [STATUS_ERROR]: { label: "Error", badge: badgeDanger },
};

export default function StatusIndicator({ statusCode }: StatusIndicatorProps) {
  const config = statusConfig[statusCode] ?? { label: "Unknown", badge: badgeNeutral };
  return <span className={config.badge}>{config.label}</span>;
}
