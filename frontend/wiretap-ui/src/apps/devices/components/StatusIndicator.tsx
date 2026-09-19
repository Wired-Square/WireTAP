// ui/src/apps/devices/components/StatusIndicator.tsx

import { useTranslation } from "react-i18next";
import { Badge, type BadgeTone } from "../../../components/Badge";
import {
  STATUS_DISCONNECTED,
  STATUS_CONNECTING,
  STATUS_CONNECTED,
  STATUS_ERROR,
} from "../../../api/bleProvision";

interface StatusIndicatorProps {
  statusCode: number;
}

const statusConfig: Record<number, { i18nKey: string; tone: BadgeTone }> = {
  [STATUS_DISCONNECTED]: { i18nKey: "disconnected", tone: "neutral" },
  [STATUS_CONNECTING]: { i18nKey: "connecting", tone: "primary" },
  [STATUS_CONNECTED]: { i18nKey: "connected", tone: "success" },
  [STATUS_ERROR]: { i18nKey: "error", tone: "danger" },
};

export default function StatusIndicator({ statusCode }: StatusIndicatorProps) {
  const { t } = useTranslation("devices");
  const config = statusConfig[statusCode] ?? { i18nKey: "unknown", tone: "neutral" };
  return <Badge tone={config.tone} size="lg">{t(`status.${config.i18nKey}`)}</Badge>;
}
