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
import { badgeWarning } from "../../../styles/badgeStyles";
import { iconMd, gapSmall } from "../../../styles/spacing";
import type { DeviceRegistryEntry } from "../../../api/deviceRegistry";

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
            <span className={badgeWarning}>{t("registered.manualBadge")}</span>
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
        <button
          type="button"
          onClick={() => onConnect(entry)}
          disabled={busy}
          aria-label={t("registered.connect")}
          title={t("registered.connect")}
          className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium rounded border border-[color:var(--border-default)] w-32 justify-center transition-colors hover:bg-[var(--bg-surface)] disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Globe className={iconMd} />
          {t("registered.connect")}
        </button>
        <button
          type="button"
          onClick={() => onRemove(entry)}
          disabled={busy}
          aria-label={t("registered.remove")}
          title={t("registered.remove")}
          className={`inline-flex items-center justify-center p-2 rounded border border-[color:var(--border-default)] ${textSecondary} transition-colors hover:text-[color:var(--status-danger-text)] disabled:cursor-not-allowed disabled:opacity-50`}
        >
          <Trash2 className={iconMd} />
        </button>
      </div>
    </div>
  );
}