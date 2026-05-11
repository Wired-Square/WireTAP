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
import { deviceScanStop, releaseDevice } from "../../api/deviceScan";
import type { UnifiedDevice } from "../../api/deviceScan";
import type { ProvisioningStatus } from "../../api/bleProvision";
import {
  STATUS_CONNECTED,
  STATUS_ERROR,
} from "../../api/bleProvision";
import DevicesScanView from "./components/DevicesScanView";
import DeviceView from "./components/DeviceView";

export default function Devices() {
  const screen = useDevicesStore((s) => s.ui.screen);

  const addDevice = useDevicesStore((s) => s.addDevice);
  const removeDevice = useDevicesStore((s) => s.removeDevice);
  const setScanning = useDevicesStore((s) => s.setScanning);

  const setProvisionState = useProvisioningStore((s) => s.setProvisionState);
  const setProvisionError = useProvisioningStore((s) => s.setError);
  const setStatusMessage = useProvisioningStore((s) => s.setStatusMessage);
  const setDeviceIpAddress = useProvisioningStore((s) => s.setDeviceIpAddress);

  useEffect(() => {
    const unlistenPromises = [
      listen<UnifiedDevice>("device-discovered", (event) => {
        addDevice(event.payload);
      }),
      listen<string>("device-disappeared", (event) => {
        removeDevice(event.payload);
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
    ];

    return () => {
      unlistenPromises.forEach((p) => p.then((unlisten) => unlisten()));
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Cleanup on unmount: stop scan, release the active device once via
  // framelink-rs (single tear-down path), reset stores.
  useEffect(() => {
    return () => {
      deviceScanStop().catch(() => {});
      const { data } = useDevicesStore.getState();
      if (data.selectedBleId) releaseDevice(data.selectedBleId).catch(() => {});
      if (data.selectedSmpId) releaseDevice(data.selectedSmpId).catch(() => {});
      useDevicesStore.getState().reset();
      useProvisioningStore.getState().reset();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="flex flex-col h-full bg-[var(--bg-primary)]">
      {screen === "scan" ? <DevicesScanView /> : <DeviceView />}
    </div>
  );
}
