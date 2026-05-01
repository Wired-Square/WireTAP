// ui/src/apps/devices/components/StatusIndicator.tsx

import { useTranslation } from "react-i18next";
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

const statusConfig: Record<number, { i18nKey: string; badge: string }> = {
  [STATUS_DISCONNECTED]: { i18nKey: "disconnected", badge: badgeNeutral },
  [STATUS_CONNECTING]: { i18nKey: "connecting", badge: badgeInfo },
  [STATUS_CONNECTED]: { i18nKey: "connected", badge: badgeSuccess },
  [STATUS_ERROR]: { i18nKey: "error", badge: badgeDanger },
};

export default function StatusIndicator({ statusCode }: StatusIndicatorProps) {
  const { t } = useTranslation("devices");
  const config = statusConfig[statusCode] ?? { i18nKey: "unknown", badge: badgeNeutral };
  return <span className={config.badge}>{t(`status.${config.i18nKey}`)}</span>;
}
