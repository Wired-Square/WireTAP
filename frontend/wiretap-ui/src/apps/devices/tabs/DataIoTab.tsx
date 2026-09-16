// ui/src/apps/devices/tabs/DataIoTab.tsx
//
// Data IO tab — probes the device for FrameLink interfaces, then offers a
// single "Add to Data IO" button that creates a grouped IO profile.

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, Loader2, Plus } from "lucide-react";
import {
  alertDanger,
  iconMd,
  textDanger,
  textPrimary,
  textSecondary,
} from "../../../styles";
import { cardDefault } from "../../../styles/cardStyles";
import { PrimaryButton } from "../../../components/forms";
import { useDevicesStore } from "../stores/devicesStore";
import { useSettingsStore } from "../../settings/stores/settingsStore";
import { useDeviceConnection } from "../hooks/useDeviceConnection";
import {
  framelinkProbeDevice,
  type FrameLinkProbeResult,
  type ProbeInterface,
} from "../../../api/framelink";
import type { IOProfile } from "../../../hooks/useSettings";

export default function DataIoTab() {
  const { t } = useTranslation("devices");
  const selectedDeviceName = useDevicesStore((s) => s.data.selectedDeviceName);
  const selectedAddress = useDevicesStore((s) => s.data.selectedAddress);
  const selectedFrameLinkPort = useDevicesStore((s) => s.data.selectedFrameLinkPort);
  const addProfile = useSettingsStore((s) => s.addProfile);

  const { ensureIpFrameLink } = useDeviceConnection();

  const [probeResult, setProbeResult] = useState<FrameLinkProbeResult | null>(null);
  const [probing, setProbing] = useState(true);
  const [probeError, setProbeError] = useState<string | null>(null);
  const [added, setAdded] = useState(false);

  const host = selectedAddress ?? "";
  const port = selectedFrameLinkPort ?? 120;

  useEffect(() => {
    if (!host) {
      setProbeError(t("frameLink.noAddress"));
      setProbing(false);
      return;
    }

    let cancelled = false;
    (async () => {
      try {
        await ensureIpFrameLink();
        const result = await framelinkProbeDevice(host, port, 5);
        if (cancelled) return;
        setProbeResult(result);
        setProbing(false);
      } catch (e) {
        if (cancelled) return;
        setProbeError(String(e));
        setProbing(false);
      }
    })();

    return () => { cancelled = true; };
  }, [host, port, ensureIpFrameLink, t]);

  const deviceLabel =
    probeResult?.device_id ?? selectedDeviceName ?? t("frameLink.fallbackName");

  const handleAddProfile = () => {
    if (!probeResult) return;
    const profile: IOProfile = {
      id: `io_fl_${Date.now()}`,
      name: deviceLabel,
      kind: "framelink",
      connection: {
        host,
        port: String(port),
        device_id: probeResult.device_id ?? undefined,
        board_name: probeResult.board_name ?? undefined,
        board_revision: probeResult.board_revision ?? undefined,
        interfaces: probeResult.interfaces.map((iface) => ({
          index: iface.index,
          iface_type: iface.iface_type,
          name: iface.name,
          type_name: iface.type_name,
        })),
      },
    };
    addProfile(profile);
    setAdded(true);
  };

  return (
    <div className="flex flex-col gap-4 p-4 h-full">
      {probing && (
        <div className="flex items-center justify-center py-12 gap-3">
          <Loader2 className={`${iconMd} animate-spin text-sky-400`} />
          <span className={`text-sm ${textSecondary}`}>{t("frameLink.probing")}</span>
        </div>
      )}

      {probeError && (
        <div className={`${alertDanger} ${textDanger} text-sm`}>{probeError}</div>
      )}

      {probeResult && (
        <>
          {probeResult.board_name && (
            <div className={`text-xs ${textSecondary}`}>
              {t("frameLink.boardLabel", { name: probeResult.board_name })}
              {probeResult.board_revision && t("frameLink.boardRevision", { revision: probeResult.board_revision })}
            </div>
          )}

          <div className="flex flex-col gap-2">
            <h3 className={`text-sm font-medium ${textPrimary}`}>
              {t("frameLink.interfacesHeading", { count: probeResult.interfaces.length })}
            </h3>
            {probeResult.interfaces.map((iface: ProbeInterface) => (
              <div key={iface.index} className={`${cardDefault} p-3 flex items-center justify-between`}>
                <div>
                  <span className={`text-sm font-medium ${textPrimary}`}>{iface.name}</span>
                  <span className={`text-xs ${textSecondary} ml-2`}>{iface.type_name}</span>
                </div>
                <span className={`text-xs ${textSecondary}`}>
                  {t("frameLink.interfaceIndex", { index: iface.index })}
                </span>
              </div>
            ))}
          </div>

          {!added ? (
            <PrimaryButton onClick={handleAddProfile} className="mt-2">
              <span className="flex items-center justify-center gap-1.5">
                <Plus className={iconMd} />
                {t("frameLink.addToDataIo")}
              </span>
            </PrimaryButton>
          ) : (
            <div className="flex items-center gap-2 p-3 text-sm text-green-700 bg-green-50 rounded-lg border border-green-200">
              <Check className={iconMd} />
              {t("frameLink.addedSuccess", { count: probeResult.interfaces.length })}
            </div>
          )}
        </>
      )}
    </div>
  );
}
