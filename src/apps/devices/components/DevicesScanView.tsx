// ui/src/apps/devices/components/DevicesScanView.tsx
//
// Unified scan view — discovers BLE devices with WiFi provisioning and/or
// SMP capabilities, plus mDNS/UDP devices.

import { useState, useEffect, useCallback, useMemo } from "react";
import { RefreshCw, Globe, ChevronDown, ChevronRight } from "lucide-react";
import { useTranslation } from "react-i18next";
import { textSecondary } from "../../../styles";
import { iconMd } from "../../../styles/spacing";
import { PrimaryButton, SecondaryButton, Input, Select } from "../../../components/forms";
import { useDevicesStore } from "../stores/devicesStore";
import { useProvisioningStore } from "../../provisioning/stores/provisioningStore";
import { useUpgradeStore } from "../../upgrade/stores/upgradeStore";
import { useSettingsStore } from "../../settings/stores/settingsStore";
import MergedDeviceCard, { type ConnectVia } from "../../../components/MergedDeviceCard";
import { mergeDevices, type MergedDevice } from "../utils/mergedDevices";
import {
  deviceScanStart,
  deviceScanStop,
} from "../../../api/deviceScan";
import {
  bleConnect,
  bleReadDeviceState,
} from "../../../api/bleProvision";
import {
  smpConnectBle,
  smpConnectUdp,
  smpListImages,
} from "../../../api/smpUpgrade";
import { framelinkProbeDevice } from "../../../api/framelink";

const STALE_PRUNE_MS = 4000;
const STALE_PRUNE_INTERVAL_MS = 1000;

export default function DevicesScanView() {
  const { t } = useTranslation("devices");
  const devices = useDevicesStore((s) => s.data.devices);
  const isScanning = useDevicesStore((s) => s.ui.isScanning);
  const error = useDevicesStore((s) => s.ui.error);

  const setScanning = useDevicesStore((s) => s.setScanning);
  const setError = useDevicesStore((s) => s.setError);
  const setConnectionState = useDevicesStore((s) => s.setConnectionState);
  const setSelectedDevice = useDevicesStore((s) => s.setSelectedDevice);
  const setStep = useDevicesStore((s) => s.setStep);
  const clearDevices = useDevicesStore((s) => s.clearDevices);
  const pruneStale = useDevicesStore((s) => s.pruneStale);

  const mergedDevices = useMemo(() => mergeDevices(devices), [devices]);

  // Provisioning store actions (for reading device state on connect)
  const setProvisionSelectedDevice = useProvisioningStore((s) => s.setSelectedDevice);
  const setDeviceSsid = useProvisioningStore((s) => s.setDeviceSsid);
  const setDeviceStatus = useProvisioningStore((s) => s.setDeviceStatus);
  const setSsid = useProvisioningStore((s) => s.setSsid);
  const setSecurity = useProvisioningStore((s) => s.setSecurity);
  const setDeviceIpAddress = useProvisioningStore((s) => s.setDeviceIpAddress);
  const setProvisionConnectionState = useProvisioningStore((s) => s.setConnectionState);

  // Upgrade store actions
  const setUpgradeSelectedDevice = useUpgradeStore((s) => s.setSelectedDevice);
  const setImages = useUpgradeStore((s) => s.setImages);
  const setUpgradeConnectionState = useUpgradeStore((s) => s.setConnectionState);

  const [connectingKey, setConnectingKey] = useState<{ name: string; via: ConnectVia } | null>(null);
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

  // While scanning, sweep stale entries (devices that stopped advertising or
  // dropped off the network) so a powered-off device disappears within ~5s.
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

  /** Stop the active scan and clear the spinner before initiating a connect. */
  const stopScanIfActive = async () => {
    if (isScanning) {
      try { await deviceScanStop(); } catch { /* ignore */ }
      setScanning(false);
    }
  };

  /** Restart scan after a failed connect, so the user can retry. */
  const restartScanAfterFailure = () => {
    clearDevices();
    setScanning(true);
    deviceScanStart().catch((scanErr) => {
      setError(String(scanErr));
      setScanning(false);
    });
  };

  /** Read current WiFi state from a freshly-connected BLE device into the provisioning store. */
  const hydrateProvisioningStateFromBle = async () => {
    try {
      const state = await bleReadDeviceState();
      if (state.ssid) {
        setDeviceSsid(state.ssid);
        setSsid(state.ssid);
      }
      if (state.security !== null && state.security !== undefined) {
        setSecurity(state.security);
      }
      setDeviceStatus(state.status);
      if (state.ip_address) {
        setDeviceIpAddress(state.ip_address);
      }
    } catch {
      // Non-critical — continue to credentials even if read fails
    }
  };

  /** Connect via BLE: routes by capability (wifi-provision → credentials, smp → inspect, framelink-only → framelink-setup). */
  const handleConnectBle = async (m: MergedDevice) => {
    if (!m.ble) return;
    const { id: bleId, capabilities: caps } = m.ble;
    const deviceId = `ble:${bleId}`;

    setError(null);
    setConnectingKey({ name: m.name, via: "ble" });
    setConnectionState("connecting");
    await stopScanIfActive();

    try {
      const isFrameLinkOnly = caps.includes("framelink") && !caps.includes("wifi-provision") && !caps.includes("smp");

      if (!isFrameLinkOnly) {
        if (caps.includes("wifi-provision")) {
          await bleConnect(bleId);
        } else if (caps.includes("smp")) {
          await smpConnectBle(bleId);
        } else {
          throw new Error("BLE device has no actionable capability");
        }
      }

      setConnectionState("connected");
      setSelectedDevice(deviceId, m.name, "ble", caps);

      if (isFrameLinkOnly) {
        setStep("framelink-setup");
      } else if (caps.includes("wifi-provision")) {
        setProvisionSelectedDevice(bleId, m.name);
        setProvisionConnectionState("connected");
        await hydrateProvisioningStateFromBle();
        setStep("credentials");
      } else {
        setUpgradeSelectedDevice(bleId, m.name, "ble");
        setUpgradeConnectionState("connected");
        try {
          const images = await smpListImages();
          setImages(images);
        } catch { /* non-critical */ }
        if (useDevicesStore.getState().ui.connectionState !== "connected") return;
        setStep("inspect");
      }
    } catch (e) {
      setConnectionState("idle");
      setError(String(e));
      restartScanAfterFailure();
    } finally {
      setConnectingKey(null);
    }
  };

  /** Connect via IP: prefers FrameLink (→ framelink-setup) and falls back to SMP-over-UDP (→ inspect). */
  const handleConnectIp = async (m: MergedDevice) => {
    setError(null);
    setConnectingKey({ name: m.name, via: "ip" });
    setConnectionState("connecting");
    await stopScanIfActive();

    try {
      if (m.framelink) {
        const deviceId = `tcp:${m.name}`;
        // FrameLink probe is performed by FrameLinkSetupView itself; here we just route.
        setConnectionState("connected");
        setSelectedDevice(deviceId, m.name, "tcp", ["framelink"]);
        setStep("framelink-setup");
      } else if (m.smp) {
        const { address, port } = m.smp;
        const deviceId = `udp:${m.name}`;
        await smpConnectUdp(address, port);
        setConnectionState("connected");
        setSelectedDevice(deviceId, m.name, "udp", ["smp"]);
        setUpgradeSelectedDevice(deviceId, m.name, "udp");
        setUpgradeConnectionState("connected");
        try {
          const images = await smpListImages();
          setImages(images);
        } catch { /* non-critical */ }
        if (useDevicesStore.getState().ui.connectionState !== "connected") return;
        setStep("inspect");
      } else {
        throw new Error("No IP transport available for this device");
      }
    } catch (e) {
      setConnectionState("idle");
      setError(String(e));
      restartScanAfterFailure();
    } finally {
      setConnectingKey(null);
    }
  };

  const handleConnect = (m: MergedDevice, via: ConnectVia) => {
    if (via === "ble") return handleConnectBle(m);
    return handleConnectIp(m);
  };

  /** Connect to a manually entered IP address. */
  const handleManualConnect = async () => {
    const address = manualAddress.trim();
    if (!address) {
      setError("Please enter an IP address");
      return;
    }
    const port = parseInt(manualPort, 10);
    if (isNaN(port) || port < 1 || port > 65535) {
      setError("Please enter a valid port number (1-65535)");
      return;
    }

    // FrameLink direct connect — probe and go to framelink-setup
    if (manualProtocol === "framelink") {
      setError(null);
      setConnectingKey({ name: address, via: "ip" });
      setConnectionState("connecting");
      if (isScanning) {
        try { await deviceScanStop(); } catch { /* ignore */ }
        setScanning(false);
      }
      try {
        const probe = await framelinkProbeDevice(address, port, 5);
        const deviceName = probe.device_id ?? address;
        const deviceId = `fl:${probe.device_id ?? address}`;
        const caps = ["framelink"];
        const { addDevice } = useDevicesStore.getState();
        addDevice({ name: deviceName, id: deviceId, transport: "udp", ble_id: null, rssi: null, address, port, capabilities: caps });
        setSelectedDevice(deviceId, deviceName, "udp", caps);
        setConnectionState("connected");
        setStep("framelink-setup");
      } catch (e) {
        setConnectionState("idle");
        setError(String(e));
      } finally {
        setConnectingKey(null);
      }
      return;
    }

    let deviceId = `udp:${address}`; // Temporary ID until we can probe for device_id
    let deviceName = address;
    setError(null);
    setConnectingKey({ name: address, via: "ip" });
    setConnectionState("connecting");

    if (isScanning) {
      try { await deviceScanStop(); } catch { /* ignore */ }
      setScanning(false);
    }

    try {
      await smpConnectUdp(address, port);
      setConnectionState("connected");

      // Probe FrameLink (port 120) to get the canonical device ID
      const caps = ["smp"];
      try {
        const probe = await framelinkProbeDevice(address, 120, 3);
        if (probe.device_id) {
          deviceId = `udp:${probe.device_id}`;
          deviceName = probe.device_id;
        }
        caps.push("framelink");
      } catch {
        // Device doesn't have FrameLink — keep address as ID
      }

      // Add to devices store so UpgradeCompleteView can find address/port
      const { addDevice } = useDevicesStore.getState();
      addDevice({ name: deviceName, id: deviceId, transport: "udp", ble_id: null, rssi: null, address, port, capabilities: caps });

      setSelectedDevice(deviceId, deviceName, "udp", caps);

      // Set up upgrade store
      setUpgradeSelectedDevice(deviceId, deviceName, "udp");
      setUpgradeConnectionState("connected");

      try {
        const images = await smpListImages();
        setImages(images);
      } catch {
        // Non-critical
      }

      if (useDevicesStore.getState().ui.connectionState !== "connected") return;
      setStep("inspect");
    } catch (e) {
      setConnectionState("idle");
      setError(String(e));
      // Restart scan
      clearDevices();
      setScanning(true);
      deviceScanStart().catch((scanErr) => {
        setError(String(scanErr));
        setScanning(false);
      });
    } finally {
      setConnectingKey(null);
    }
  };

  const connecting = connectingKey !== null;

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

      {/* Error */}
      {error && (
        <div className="p-3 text-sm text-red-600 bg-red-50 rounded-lg border border-red-200">
          {error}
        </div>
      )}

      {/* Scanning spinner */}
      {isScanning && mergedDevices.length === 0 && (
        <div className="flex items-center justify-center py-8">
          <div className="w-6 h-6 border-2 border-sky-500 border-t-transparent rounded-full animate-spin" />
        </div>
      )}

      {/* Device list */}
      <div className="flex flex-col gap-2 overflow-y-auto flex-1">
        {mergedDevices.map((device) => (
          <MergedDeviceCard
            key={device.name}
            device={device}
            onConnect={handleConnect}
            connecting={connectingKey}
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
                disabled={connecting}
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
                disabled={connecting}
              />
            </div>
            <div className="w-20">
              <label className={`text-xs ${textSecondary} mb-1 block`}>{t("scan.manualPort")}</label>
              <Input
                value={manualPort}
                onChange={(e) => setManualPort(e.target.value)}
                placeholder={manualProtocol === "framelink" ? "120" : "1337"}
                disabled={connecting}
              />
            </div>
            <PrimaryButton onClick={handleManualConnect} disabled={connecting}>
              <span className="flex items-center gap-1.5">
                <Globe className={`${iconMd} ${connecting ? "animate-pulse" : ""}`} />
                {connecting ? t("scan.connecting") : t("scan.connect")}
              </span>
            </PrimaryButton>
          </div>
        )}
      </div>
    </div>
  );
}
