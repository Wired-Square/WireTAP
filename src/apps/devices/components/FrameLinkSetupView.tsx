// ui/src/apps/devices/components/FrameLinkSetupView.tsx
//
// FrameLink device setup — probes the device, shows discovered interfaces,
// and creates a single grouped IO profile with all interfaces.

import { useState, useEffect } from "react";
import { ArrowLeft, Plus, Check, Loader2 } from "lucide-react";
import { textPrimary, textSecondary } from "../../../styles";
import { iconMd } from "../../../styles/spacing";
import { cardDefault } from "../../../styles/cardStyles";
import { PrimaryButton, SecondaryButton } from "../../../components/forms";
import { useDevicesStore } from "../stores/devicesStore";
import { useSettingsStore } from "../../settings/stores/settingsStore";
import {
  framelinkProbeDevice,
  type ProbeInterface,
  type FrameLinkProbeResult,
} from "../../../api/framelink";
import type { IOProfile } from "../../../hooks/useSettings";

export default function FrameLinkSetupView() {
  const selectedDeviceName = useDevicesStore((s) => s.data.selectedDeviceName);
  const selectedDeviceId = useDevicesStore((s) => s.data.selectedDeviceId);
  const devices = useDevicesStore((s) => s.data.devices);
  const setStep = useDevicesStore((s) => s.setStep);
  const setConnectionState = useDevicesStore((s) => s.setConnectionState);
  const addProfile = useSettingsStore((s) => s.addProfile);

  const [probeResult, setProbeResult] = useState<FrameLinkProbeResult | null>(null);
  const [probing, setProbing] = useState(true);
  const [probeError, setProbeError] = useState<string | null>(null);
  const [added, setAdded] = useState(false);

  // Extract host/port from the selected device
  const device = devices.find((d) => d.id === selectedDeviceId);
  const host = device?.address ?? "";
  const port = 120; // Standard FrameLink port (device.port may be the SMP port)

  // Probe on mount
  useEffect(() => {
    if (!host) {
      setProbeError("No device address available");
      setProbing(false);
      return;
    }

    let cancelled = false;
    (async () => {
      try {
        const result = await framelinkProbeDevice(host, port, 5);
        if (!cancelled) {
          setProbeResult(result);
          setProbing(false);
        }
      } catch (e) {
        if (!cancelled) {
          setProbeError(String(e));
          setProbing(false);
        }
      }
    })();

    return () => { cancelled = true; };
  }, [host, port]);

  const handleBack = () => {
    setConnectionState("idle");
    setStep("scan");
  };

  // Use device_id from capabilities as the canonical label (e.g. "WiredFlexLink-9D04")
  const deviceLabel = probeResult?.device_id ?? selectedDeviceName ?? "FrameLink";

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
      {/* Header */}
      <div className="flex items-center gap-3">
        <SecondaryButton onClick={handleBack} className="px-2 py-1">
          <ArrowLeft className={iconMd} />
        </SecondaryButton>
        <div>
          <h2 className={`text-sm font-medium ${textPrimary}`}>
            {deviceLabel}
          </h2>
          <span className={`text-xs ${textSecondary}`}>
            {host}:{port}
          </span>
        </div>
      </div>

      {/* Probing state */}
      {probing && (
        <div className="flex items-center justify-center py-12 gap-3">
          <Loader2 className={`${iconMd} animate-spin text-sky-400`} />
          <span className={`text-sm ${textSecondary}`}>Probing device...</span>
        </div>
      )}

      {/* Error */}
      {probeError && (
        <div className="p-3 text-sm text-red-600 bg-red-50 rounded-lg border border-red-200">
          {probeError}
        </div>
      )}

      {/* Probe results */}
      {probeResult && (
        <>
          {probeResult.board_name && (
            <div className={`text-xs ${textSecondary}`}>
              Board: {probeResult.board_name}
              {probeResult.board_revision && ` rev ${probeResult.board_revision}`}
            </div>
          )}

          <div className="flex flex-col gap-2">
            <h3 className={`text-sm font-medium ${textPrimary}`}>
              Interfaces ({probeResult.interfaces.length})
            </h3>
            {probeResult.interfaces.map((iface: ProbeInterface) => (
              <div key={iface.index} className={`${cardDefault} p-3 flex items-center justify-between`}>
                <div>
                  <span className={`text-sm font-medium ${textPrimary}`}>{iface.name}</span>
                  <span className={`text-xs ${textSecondary} ml-2`}>{iface.type_name}</span>
                </div>
                <span className={`text-xs ${textSecondary}`}>Index {iface.index}</span>
              </div>
            ))}
          </div>

          {!added ? (
            <PrimaryButton onClick={handleAddProfile} className="mt-2">
              <span className="flex items-center justify-center gap-1.5">
                <Plus className={iconMd} />
                Add Device to Data I/O
              </span>
            </PrimaryButton>
          ) : (
            <div className="flex items-center gap-2 p-3 text-sm text-green-700 bg-green-50 rounded-lg border border-green-200">
              <Check className={iconMd} />
              Device added to Data I/O with {probeResult.interfaces.length} interface{probeResult.interfaces.length !== 1 ? "s" : ""}. You can configure it in Settings.
            </div>
          )}
        </>
      )}
    </div>
  );
}
