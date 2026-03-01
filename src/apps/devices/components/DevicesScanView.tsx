// ui/src/apps/devices/components/DevicesScanView.tsx
//
// Unified scan view — discovers BLE devices with WiFi provisioning and/or
// SMP capabilities, plus mDNS/UDP devices.

import { useState, useEffect, useCallback } from "react";
import { RefreshCw, Globe, ChevronDown, ChevronRight } from "lucide-react";
import { textSecondary } from "../../../styles";
import { iconMd } from "../../../styles/spacing";
import { PrimaryButton, SecondaryButton, Input } from "../../../components/forms";
import { useDevicesStore } from "../stores/devicesStore";
import { useProvisioningStore } from "../../provisioning/stores/provisioningStore";
import { useUpgradeStore } from "../../upgrade/stores/upgradeStore";
import { useSettingsStore } from "../../settings/stores/settingsStore";
import DeviceCard from "../../../components/DeviceCard";
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

export default function DevicesScanView() {
  const devices = useDevicesStore((s) => s.data.devices);
  const isScanning = useDevicesStore((s) => s.ui.isScanning);
  const error = useDevicesStore((s) => s.ui.error);

  const setScanning = useDevicesStore((s) => s.setScanning);
  const setError = useDevicesStore((s) => s.setError);
  const setConnectionState = useDevicesStore((s) => s.setConnectionState);
  const setSelectedDevice = useDevicesStore((s) => s.setSelectedDevice);
  const setStep = useDevicesStore((s) => s.setStep);
  const clearDevices = useDevicesStore((s) => s.clearDevices);

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

  const [connectingDeviceId, setConnectingDeviceId] = useState<string | null>(null);
  const [showManualIp, setShowManualIp] = useState(false);
  const [manualAddress, setManualAddress] = useState("");
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

  /** Connect to a BLE device and route to the appropriate first step. */
  const handleConnect = async (deviceId: string) => {
    setError(null);
    setConnectingDeviceId(deviceId);
    setConnectionState("connecting");

    // Stop scanning if active
    if (isScanning) {
      try { await deviceScanStop(); } catch { /* ignore */ }
      setScanning(false);
    }

    const device = devices.find((d) => d.id === deviceId);
    const caps = device?.capabilities ?? [];
    const transport = device?.transport ?? "ble";
    const name = device?.name ?? deviceId;

    try {
      // Connect using the appropriate protocol
      if (transport === "udp" && device?.address && device?.port) {
        await smpConnectUdp(device.address, device.port);
      } else if (caps.includes("wifi-provision")) {
        // WiFi provisioning connect (also covers devices with both caps)
        await bleConnect(deviceId);
      } else {
        // SMP-only BLE device
        await smpConnectBle(deviceId);
      }

      setConnectionState("connected");
      setSelectedDevice(deviceId, name, transport, caps);

      // Route to the appropriate first step
      if (caps.includes("wifi-provision")) {
        // Set up provisioning store state
        setProvisionSelectedDevice(deviceId, name);
        setProvisionConnectionState("connected");

        // Read current WiFi state from device
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

        setStep("credentials");
      } else if (caps.includes("smp")) {
        // SMP-only device — go straight to inspect
        setUpgradeSelectedDevice(deviceId, name, transport);
        setUpgradeConnectionState("connected");

        try {
          const images = await smpListImages();
          setImages(images);
        } catch {
          // Non-critical
        }

        // Guard: disconnect event may have reset state
        if (useDevicesStore.getState().ui.connectionState !== "connected") return;
        setStep("inspect");
      }
    } catch (e) {
      setConnectionState("idle");
      setError(String(e));
      // Restart scan so user can retry
      clearDevices();
      setScanning(true);
      deviceScanStart().catch((scanErr) => {
        setError(String(scanErr));
        setScanning(false);
      });
    } finally {
      setConnectingDeviceId(null);
    }
  };

  /** Connect to a manually entered IP address (UDP/SMP only). */
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

    const deviceId = `udp:${address}:${port}`;
    setError(null);
    setConnectingDeviceId(deviceId);
    setConnectionState("connecting");

    if (isScanning) {
      try { await deviceScanStop(); } catch { /* ignore */ }
      setScanning(false);
    }

    try {
      await smpConnectUdp(address, port);
      setConnectionState("connected");
      setSelectedDevice(deviceId, address, "udp", ["smp"]);

      // Set up upgrade store
      setUpgradeSelectedDevice(deviceId, address, "udp");
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
      setConnectingDeviceId(null);
    }
  };

  const connecting = connectingDeviceId !== null;

  return (
    <div className="flex flex-col gap-4 p-4 h-full">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className={`text-sm ${textSecondary}`}>
          {isScanning
            ? "Scanning for devices..."
            : devices.length > 0
              ? `Found ${devices.length} device${devices.length !== 1 ? "s" : ""}`
              : "No devices found"}
        </div>
        <SecondaryButton onClick={handleRescan} disabled={isScanning} className="w-32 mr-3">
          <span className="flex items-center justify-center gap-1.5">
            <RefreshCw className={iconMd} />
            Rescan
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
      {isScanning && devices.length === 0 && (
        <div className="flex items-center justify-center py-8">
          <div className="w-6 h-6 border-2 border-sky-500 border-t-transparent rounded-full animate-spin" />
        </div>
      )}

      {/* Device list */}
      <div className="flex flex-col gap-2 overflow-y-auto flex-1">
        {devices.map((device) => (
          <DeviceCard
            key={device.id}
            device={device}
            onConnect={handleConnect}
            connectingDeviceId={connectingDeviceId}
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
          Manual IP Address
        </button>

        {showManualIp && (
          <div className="flex items-end gap-2 mt-2">
            <div className="flex-1">
              <label className={`text-xs ${textSecondary} mb-1 block`}>IP Address</label>
              <Input
                value={manualAddress}
                onChange={(e) => setManualAddress(e.target.value)}
                placeholder="192.168.1.100"
                disabled={connecting}
              />
            </div>
            <div className="w-20">
              <label className={`text-xs ${textSecondary} mb-1 block`}>Port</label>
              <Input
                value={manualPort}
                onChange={(e) => setManualPort(e.target.value)}
                placeholder="1337"
                disabled={connecting}
              />
            </div>
            <PrimaryButton onClick={handleManualConnect} disabled={connecting}>
              <span className="flex items-center gap-1.5">
                <Globe className={`${iconMd} ${connecting ? "animate-pulse" : ""}`} />
                {connecting ? "..." : "Connect"}
              </span>
            </PrimaryButton>
          </div>
        )}
      </div>
    </div>
  );
}
