// ui/src/apps/devices/components/DeviceHeader.tsx
//
// One header for the per-device tabbed page. The single back button on the
// left is the only way out — it disconnects every live transport before
// returning to scan, so individual tabs never need their own back/disconnect
// plumbing.

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowLeft } from "lucide-react";
import { textPrimary, textSecondary } from "../../../styles";
import { iconMd } from "../../../styles/spacing";
import { SecondaryButton } from "../../../components/forms";
import { useDevicesStore } from "../stores/devicesStore";
import { useDeviceConnection } from "../hooks/useDeviceConnection";

export default function DeviceHeader() {
  const { t } = useTranslation("devices");
  const selectedDeviceName = useDevicesStore((s) => s.data.selectedDeviceName);
  const selectedAddress = useDevicesStore((s) => s.data.selectedAddress);
  const setScreen = useDevicesStore((s) => s.setScreen);
  const setError = useDevicesStore((s) => s.setError);

  const { disconnectAll } = useDeviceConnection();
  const [leaving, setLeaving] = useState(false);

  const handleBack = async () => {
    setLeaving(true);
    setError(null);
    try {
      await disconnectAll();
    } finally {
      setScreen("scan");
      setLeaving(false);
    }
  };

  return (
    <div className="flex items-center gap-3 px-4 py-2 border-b border-[color:var(--border-default)]">
      <SecondaryButton onClick={handleBack} disabled={leaving} className="px-2 py-1">
        <span className="flex items-center gap-1.5">
          <ArrowLeft className={iconMd} />
          {t("device.back")}
        </span>
      </SecondaryButton>
      <div className="min-w-0 flex-1">
        <div className={`text-sm font-medium ${textPrimary} truncate`}>
          {selectedDeviceName ?? t("device.unknown")}
        </div>
        {selectedAddress && (
          <div className={`text-xs ${textSecondary} truncate`}>{selectedAddress}</div>
        )}
      </div>
    </div>
  );
}
