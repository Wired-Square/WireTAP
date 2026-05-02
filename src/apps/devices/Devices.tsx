// ui/src/apps/devices/Devices.tsx
//
// Top-level devices panel: holds the Tauri event subscriptions, switches
// between the scan list and the per-device tabbed page. All tab-specific
// logic lives in tabs/ and the lifecycle plumbing lives in
// hooks/useDeviceConnection.

import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { useDevicesStore } from "./stores/devicesStore";
import { useProvisioningStore } from "../provisioning/stores/provisioningStore";
import { useUpgradeStore } from "../upgrade/stores/upgradeStore";
import { bleDisconnect } from "../../api/bleProvision";
import { smpDisconnect } from "../../api/smpUpgrade";
import { deviceScanStop } from "../../api/deviceScan";
import type { UnifiedDevice } from "../../api/deviceScan";
import type { ProvisioningStatus } from "../../api/bleProvision";
import type { UploadProgress } from "../../api/smpUpgrade";
import {
  STATUS_CONNECTED,
  STATUS_ERROR,
} from "../../api/bleProvision";
import DevicesScanView from "./components/DevicesScanView";
import DeviceView from "./components/DeviceView";

export default function Devices() {
  const screen = useDevicesStore((s) => s.ui.screen);

  const addDevice = useDevicesStore((s) => s.addDevice);
  const setScanning = useDevicesStore((s) => s.setScanning);
  const setScreen = useDevicesStore((s) => s.setScreen);
  const setError = useDevicesStore((s) => s.setError);
  const resetTransports = useDevicesStore((s) => s.resetTransports);
  const setConnectionState = useDevicesStore((s) => s.setConnectionState);

  const setProvisionState = useProvisioningStore((s) => s.setProvisionState);
  const setProvisionError = useProvisioningStore((s) => s.setError);
  const setStatusMessage = useProvisioningStore((s) => s.setStatusMessage);
  const setDeviceIpAddress = useProvisioningStore((s) => s.setDeviceIpAddress);

  const setUploadProgress = useUpgradeStore((s) => s.setUploadProgress);

  useEffect(() => {
    const unlistenPromises = [
      listen<UnifiedDevice>("device-discovered", (event) => {
        addDevice(event.payload);
      }),
      listen<void>("device-scan-finished", () => {
        setScanning(false);
      }),

      listen<ProvisioningStatus>("ble-provision-status", (event) => {
        const { status, status_code } = event.payload;
        setStatusMessage(`Device status: ${status}`);

        if (status_code === STATUS_CONNECTED) {
          setProvisionState("connected");
        } else if (status_code === STATUS_ERROR) {
          setProvisionState("error");
          setProvisionError("Device reported an error while connecting to WiFi");
        }
      }),
      listen<string>("ble-provision-ip", (event) => {
        setDeviceIpAddress(event.payload);
      }),

      listen<UploadProgress>("smp-upload-progress", (event) => {
        setUploadProgress(event.payload);
      }),
      listen<void>("smp-upload-complete", () => {
        // Upload complete — FirmwareTab handles the rest
      }),

      listen<string>("ble-device-disconnected", () => {
        const { ui } = useDevicesStore.getState();
        if (ui.screen !== "device") return;
        resetTransports();
        setConnectionState("idle");
        setError("Device disconnected unexpectedly");
        setScreen("scan");
        useProvisioningStore.getState().reset();
        useUpgradeStore.getState().reset();
      }),
      listen<string>("smp-device-disconnected", () => {
        const { ui } = useDevicesStore.getState();
        if (ui.screen !== "device") return;
        resetTransports();
        setConnectionState("idle");
        setError("Device disconnected unexpectedly");
        setScreen("scan");
        useProvisioningStore.getState().reset();
        useUpgradeStore.getState().reset();
      }),
    ];

    return () => {
      unlistenPromises.forEach((p) => p.then((unlisten) => unlisten()));
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Cleanup on unmount: stop scan, disconnect everything, reset stores.
  useEffect(() => {
    return () => {
      deviceScanStop().catch(() => {});
      bleDisconnect().catch(() => {});
      smpDisconnect().catch(() => {});
      useDevicesStore.getState().reset();
      useProvisioningStore.getState().reset();
      useUpgradeStore.getState().reset();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="flex flex-col h-full bg-[var(--bg-primary)]">
      {screen === "scan" ? <DevicesScanView /> : <DeviceView />}
    </div>
  );
}
