// ui/src/apps/devices/components/DevicesScanView.tsx
//
// Unified scan view — discovers BLE devices with WiFi provisioning and/or
// SMP capabilities, plus mDNS/UDP devices. Clicking BLE / IP / Manual IP
// just stages the device selection and lands on the appropriate tab; the
// tab itself handles its own connection lifecycle.

import { useState, useEffect, useCallback, useMemo } from "react";
import { ChevronDown, ChevronRight, Globe, RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";
import { textSecondary } from "../../../styles";
import { iconMd } from "../../../styles/spacing";
import { Input, PrimaryButton, SecondaryButton, Select } from "../../../components/forms";
import {
  useDevicesStore,
  type DeviceTabId,
} from "../stores/devicesStore";
import { useSettingsStore } from "../../settings/stores/settingsStore";
import MergedDeviceCard, { type ConnectVia } from "../../../components/MergedDeviceCard";
import { mergeDevices, type MergedDevice } from "../utils/mergedDevices";
import {
  deviceScanStart,
  deviceScanStop,
} from "../../../api/deviceScan";

const STALE_PRUNE_MS = 4000;
const STALE_PRUNE_INTERVAL_MS = 1000;

/** Pick which tab to land on, given a device and the chosen transport. */
function pickInitialTab(
  m: MergedDevice,
  via: ConnectVia,
): DeviceTabId | null {
  if (via === "ble") {
    if (!m.ble) return null;
    const caps = m.ble.capabilities;
    // Diagnostic: prefer SMP-direct when both wifi-prov and SMP are
    // advertised, so we can isolate whether opening wifi-prov first
    // affects subsequent SMP-side behaviour. Restore wifi preference
    // once the question is settled.
    if (caps.includes("smp")) return "firmware";
    if (caps.includes("wifi-provision")) return "wifi";
    if (caps.includes("framelink") && m.framelink) return "dataio";
    return null;
  }
  // via === "ip"
  if (m.smp) return "firmware";
  if (m.framelink) return "dataio";
  return null;
}

/** Roll the merged device + chosen transport into the devicesStore selection. */
function selectionFromMerged(m: MergedDevice, via: ConnectVia) {
  const caps: string[] = [];
  if (m.ble) caps.push(...m.ble.capabilities);
  if (m.smp) caps.push("smp");
  if (m.framelink) caps.push("framelink");
  const dedupCaps = [...new Set(caps)];
  // Prefer the FrameLink address (mDNS-discovered) when present, since both
  // SMP-UDP and FrameLink-TCP share an IP — the SMP entry just has a different
  // port advertised. Manual-IP entries also use this form.
  const address = m.framelink?.address ?? m.smp?.address ?? null;
  return {
    id: `${via}:${m.name}`,
    name: m.name,
    bleId: m.ble?.id ?? null,
    address,
    smpId: m.smp?.id ?? null,
    smpPort: m.smp?.port ?? null,
    frameLinkPort: m.framelink?.port ?? null,
    capabilities: dedupCaps,
  };
}

export default function DevicesScanView() {
  const { t } = useTranslation("devices");
  const devices = useDevicesStore((s) => s.data.devices);
  const isScanning = useDevicesStore((s) => s.ui.isScanning);
  const error = useDevicesStore((s) => s.ui.error);

  const setScanning = useDevicesStore((s) => s.setScanning);
  const setError = useDevicesStore((s) => s.setError);
  const selectDevice = useDevicesStore((s) => s.selectDevice);
  const setScreen = useDevicesStore((s) => s.setScreen);
  const setActiveTab = useDevicesStore((s) => s.setActiveTab);
  const clearDevices = useDevicesStore((s) => s.clearDevices);
  const pruneStale = useDevicesStore((s) => s.pruneStale);

  const mergedDevices = useMemo(() => mergeDevices(devices), [devices]);

  const [showManualIp, setShowManualIp] = useState(false);
  const [manualAddress, setManualAddress] = useState("");
  const [manualProtocol, setManualProtocol] = useState<"smp" | "framelink">("smp");
  const [manualPort, setManualPort] = useState(() =>
    String(useSettingsStore.getState().general.smpPort),
  );

  // Auto-scan on mount, stop on unmount
  useEffect(() => {
    let cancelled = false;
    clearDevices();
    setError(null);
    setScanning(true);

    (async () => {
      try { await deviceScanStop(); } catch { /* ignore */ }
      if (cancelled) return;
      try {
        await deviceScanStart();
      } catch (e) {
        if (!cancelled) {
          setError(String(e));
          setScanning(false);
        }
      }
    })();

    return () => {
      cancelled = true;
      deviceScanStop().catch(() => {});
      setScanning(false);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Sweep stale entries while scanning so a powered-off device disappears
  // within ~5s.
  useEffect(() => {
    if (!isScanning) return;
    const handle = window.setInterval(() => {
      pruneStale(STALE_PRUNE_MS);
    }, STALE_PRUNE_INTERVAL_MS);
    return () => window.clearInterval(handle);
  }, [isScanning, pruneStale]);

  const handleRescan = useCallback(async () => {
    clearDevices();
    setError(null);
    setScanning(true);
    try { await deviceScanStop(); } catch { /* ignore */ }
    try {
      await deviceScanStart();
    } catch (e) {
      setError(String(e));
      setScanning(false);
    }
  }, [clearDevices, setError, setScanning]);

  const enterDevice = useCallback(async (selection: ReturnType<typeof selectionFromMerged>, tab: DeviceTabId) => {
    if (isScanning) {
      try { await deviceScanStop(); } catch { /* ignore */ }
      setScanning(false);
    }
    setError(null);
    selectDevice(selection);
    setActiveTab(tab);
    setScreen("device");
  }, [isScanning, selectDevice, setActiveTab, setScreen, setError, setScanning]);

  const handleConnect = useCallback(async (m: MergedDevice, via: ConnectVia) => {
    const tab = pickInitialTab(m, via);
    if (!tab) {
      setError(
        via === "ble"
          ? t("scan.errors.bleNoActionable")
          : t("scan.errors.ipNoActionable"),
      );
      return;
    }
    await enterDevice(selectionFromMerged(m, via), tab);
  }, [enterDevice, setError, t]);

  const handleManualConnect = useCallback(async () => {
    const address = manualAddress.trim();
    if (!address) {
      setError(t("scan.errors.addressRequired"));
      return;
    }
    const port = parseInt(manualPort, 10);
    if (isNaN(port) || port < 1 || port > 65535) {
      setError(t("scan.errors.invalidPort"));
      return;
    }

    const isFrameLink = manualProtocol === "framelink";
    const selection = {
      id: isFrameLink ? `fl:${address}` : `udp:${address}`,
      name: address,
      bleId: null,
      address,
      smpId: null,
      smpPort: isFrameLink ? null : port,
      frameLinkPort: isFrameLink ? port : null,
      capabilities: isFrameLink ? ["framelink"] : ["smp"],
    };
    await enterDevice(selection, isFrameLink ? "dataio" : "firmware");
  }, [manualAddress, manualPort, manualProtocol, enterDevice, setError, t]);

  return (
    <div className="flex flex-col gap-4 p-4 h-full">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className={`text-sm ${textSecondary}`}>
          {isScanning
            ? t("scan.scanning")
            : mergedDevices.length > 0
              ? t("scan.foundDevices", { count: mergedDevices.length })
              : t("scan.noDevices")}
        </div>
        <SecondaryButton onClick={handleRescan} disabled={isScanning} className="w-32 mr-3">
          <span className="flex items-center justify-center gap-1.5">
            <RefreshCw className={iconMd} />
            {t("scan.rescan")}
          </span>
        </SecondaryButton>
      </div>

      {error && (
        <div className="p-3 text-sm text-red-600 bg-red-50 rounded-lg border border-red-200">
          {error}
        </div>
      )}

      {isScanning && mergedDevices.length === 0 && (
        <div className="flex items-center justify-center py-8">
          <div className="w-6 h-6 border-2 border-sky-500 border-t-transparent rounded-full animate-spin" />
        </div>
      )}

      <div className="flex flex-col gap-2 overflow-y-auto flex-1">
        {mergedDevices.map((device) => (
          <MergedDeviceCard
            key={device.name}
            device={device}
            onConnect={handleConnect}
            connecting={null}
          />
        ))}
      </div>

      {/* Manual IP entry */}
      <div className="border-t border-[color:var(--border-default)] pt-3">
        <button
          onClick={() => setShowManualIp(!showManualIp)}
          className={`flex items-center gap-1.5 text-sm ${textSecondary} hover:text-[color:var(--text-primary)] transition-colors`}
        >
          {showManualIp ? (
            <ChevronDown className={iconMd} />
          ) : (
            <ChevronRight className={iconMd} />
          )}
          {t("scan.manualIp")}
        </button>

        {showManualIp && (
          <div className="flex items-end gap-2 mt-2">
            <div className="w-32">
              <label className={`text-xs ${textSecondary} mb-1 block`}>{t("scan.manualType")}</label>
              <Select
                value={manualProtocol}
                onChange={(e) => {
                  const proto = e.target.value as "smp" | "framelink";
                  setManualProtocol(proto);
                  setManualPort(proto === "framelink" ? "120" : String(useSettingsStore.getState().general.smpPort));
                }}
              >
                <option value="smp">SMP</option>
                <option value="framelink">FrameLink</option>
              </Select>
            </div>
            <div className="flex-1">
              <label className={`text-xs ${textSecondary} mb-1 block`}>{t("scan.manualIpAddress")}</label>
              <Input
                value={manualAddress}
                onChange={(e) => setManualAddress(e.target.value)}
                placeholder={t("scan.manualIpPlaceholder")}
              />
            </div>
            <div className="w-20">
              <label className={`text-xs ${textSecondary} mb-1 block`}>{t("scan.manualPort")}</label>
              <Input
                value={manualPort}
                onChange={(e) => setManualPort(e.target.value)}
                placeholder={manualProtocol === "framelink" ? "120" : "1337"}
              />
            </div>
            <PrimaryButton onClick={handleManualConnect}>
              <span className="flex items-center gap-1.5">
                <Globe className={iconMd} />
                {t("scan.connect")}
              </span>
            </PrimaryButton>
          </div>
        )}
      </div>
    </div>
  );
}
