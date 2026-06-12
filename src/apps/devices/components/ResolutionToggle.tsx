// ui/src/apps/devices/components/ResolutionToggle.tsx
//
// Per-device Auto/Manual resolution control. Manual pins the device to its
// current address in the framelink-rs registry (reached directly on every
// transport, never discovered); Auto removes the pin and restores mDNS
// resolution. Only meaningful for an IP-reachable device, so it renders
// nothing when the selected device has no address.

import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { textSecondary } from "../../../styles";
import { Select } from "../../../components/forms";
import { useDevicesStore } from "../stores/devicesStore";
import {
  registryGet,
  registrySetManual,
  registrySetAuto,
  type Resolution,
} from "../../../api/deviceRegistry";

export default function ResolutionToggle() {
  const { t } = useTranslation("devices");
  const deviceId = useDevicesStore((s) => s.data.selectedDeviceId);
  const address = useDevicesStore((s) => s.data.selectedAddress);
  const smpPort = useDevicesStore((s) => s.data.selectedSmpPort);
  const frameLinkPort = useDevicesStore((s) => s.data.selectedFrameLinkPort);

  const [resolution, setResolution] = useState<Resolution>("auto");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (!deviceId) return;
    (async () => {
      try {
        const rec = await registryGet(deviceId);
        if (!cancelled) setResolution(rec?.resolution ?? "auto");
      } catch {
        if (!cancelled) setResolution("auto");
      }
    })();
    return () => { cancelled = true; };
  }, [deviceId]);

  const handleChange = useCallback(async (next: Resolution) => {
    if (!deviceId) return;
    const previous = resolution;
    setResolution(next);
    setBusy(true);
    try {
      if (next === "manual") {
        if (!address) throw new Error("no address to pin");
        await registrySetManual(deviceId, address, {
          framelinkPort: frameLinkPort ?? undefined,
          smpPort: smpPort ?? undefined,
        });
      } else {
        await registrySetAuto(deviceId);
      }
    } catch {
      setResolution(previous); // revert on failure
    } finally {
      setBusy(false);
    }
  }, [deviceId, address, frameLinkPort, smpPort, resolution]);

  // Manual resolution pins an address; without one there's nothing to pin.
  if (!deviceId || !address) return null;

  return (
    <div className="flex items-center gap-2">
      <label className={`text-xs ${textSecondary}`}>{t("resolution.label")}</label>
      <Select
        value={resolution}
        disabled={busy}
        onChange={(e) => handleChange(e.target.value as Resolution)}
      >
        <option value="auto">{t("resolution.auto")}</option>
        <option value="manual">{t("resolution.manual")}</option>
      </Select>
    </div>
  );
}