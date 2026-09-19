// ui/src/apps/devices/components/RegisteredDeviceRow.tsx
//
// One row per registered device (framelink-rs registry entry). Unlike the
// live-scan card, this never asserts live state — a registered device is
// "known and reachable at a stored host", not "seen on the network now". It
// shows identity + stored host/ports + resolution mode, and offers connect
// and remove actions.

import { Globe, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cardDefault } from "../../../styles/cardStyles";
import { textPrimary, textSecondary } from "../../../styles";
import { iconMd, gapSmall } from "../../../styles/spacing";
import type { DeviceRegistryEntry } from "../../../api/deviceRegistry";
import { IconButton } from "../../../components/Button";
import { SecondaryButton } from "../../../components/forms";
import { Badge } from "../../../components/Badge";

interface RegisteredDeviceRowProps {
  entry: DeviceRegistryEntry;
  onConnect: (entry: DeviceRegistryEntry) => void;
  onRemove: (entry: DeviceRegistryEntry) => void;
  busy: boolean;
}

export default function RegisteredDeviceRow({
  entry,
  onConnect,
  onRemove,
  busy,
}: RegisteredDeviceRowProps) {
  const { t } = useTranslation("devices");

  return (
    <div className={`${cardDefault} flex items-center justify-between p-4`}>
      <div className="flex-1 min-w-0">
        <div className={`flex items-center flex-wrap ${gapSmall}`}>
          <h3 className={`font-medium ${textPrimary} truncate`}>{entry.device_id}</h3>
          {entry.resolution === "manual" && (
            <Badge tone="warning" size="lg">{t("registered.manualBadge")}</Badge>
          )}
        </div>
        {entry.host && (
          <div className="mt-2 flex flex-wrap gap-2">
            <span className={`text-xs font-mono ${textSecondary}`}>
              {entry.host} · tcp:{entry.framelink_port} udp:{entry.smp_port}
            </span>
          </div>
        )}
      </div>

      <div className={`flex items-center ${gapSmall} ml-4`}>
        <SecondaryButton
          onClick={() => onConnect(entry)}
          disabled={busy}
          aria-label={t("registered.connect")}
          title={t("registered.connect")}
          className="w-32"
        >
          <Globe className={iconMd} />
          {t("registered.connect")}
        </SecondaryButton>
        <IconButton
          onClick={() => onRemove(entry)}
          disabled={busy}
          aria-label={t("registered.remove")}
          title={t("registered.remove")}
          variant="outline"
          tone="danger"
        >
          <Trash2 className={iconMd} />
        </IconButton>
      </div>
    </div>
  );
}