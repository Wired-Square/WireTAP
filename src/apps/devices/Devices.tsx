// ui/src/apps/devices/Devices.tsx
//
// Unified Devices panel — combines WiFi provisioning and firmware upgrade
// into a single wizard that adapts based on device capabilities.

import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { Cpu } from "lucide-react";
import { bgPrimary, textPrimary, textSecondary } from "../../styles";
import { iconMd } from "../../styles/spacing";
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
import CredentialsView from "./components/CredentialsView";
import ProvisioningView from "./components/ProvisioningView";
import ProvisionCompleteView from "./components/ProvisionCompleteView";
import InspectView from "./components/InspectView";
import UploadView from "./components/UploadView";
import UpgradeCompleteView from "./components/UpgradeCompleteView";
import StatusIndicator from "./components/StatusIndicator";

export default function Devices() {
  const step = useDevicesStore((s) => s.ui.step);
  const connectionState = useDevicesStore((s) => s.ui.connectionState);
  const selectedDeviceName = useDevicesStore((s) => s.data.selectedDeviceName);

  const addDevice = useDevicesStore((s) => s.addDevice);
  const setScanning = useDevicesStore((s) => s.setScanning);
  const setConnectionState = useDevicesStore((s) => s.setConnectionState);
  const setStep = useDevicesStore((s) => s.setStep);
  const setError = useDevicesStore((s) => s.setError);

  const setProvisionState = useProvisioningStore((s) => s.setProvisionState);
  const setProvisionError = useProvisioningStore((s) => s.setError);
  const setStatusMessage = useProvisioningStore((s) => s.setStatusMessage);
  const setDeviceIpAddress = useProvisioningStore((s) => s.setDeviceIpAddress);

  const setUploadProgress = useUpgradeStore((s) => s.setUploadProgress);

  // Set up Tauri event listeners
  useEffect(() => {
    const unlistenPromises = [
      // Unified device scan events
      listen<UnifiedDevice>("device-discovered", (event) => {
        addDevice(event.payload);
      }),
      listen<void>("device-scan-finished", () => {
        setScanning(false);
      }),

      // Provisioning status events
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

      // Firmware upload events
      listen<UploadProgress>("smp-upload-progress", (event) => {
        setUploadProgress(event.payload);
      }),
      listen<void>("smp-upload-complete", () => {
        // Upload complete — UploadView handles the rest
      }),

      // BLE disconnect events (from either provisioning or SMP)
      listen<string>("ble-device-disconnected", () => {
        const { ui } = useDevicesStore.getState();
        if (ui.connectionState === "idle" || ui.connectionState === "connecting") return;
        setConnectionState("idle");
        setStep("scan");
        setError("Device disconnected unexpectedly");
        // Reset sub-stores
        useProvisioningStore.getState().reset();
        useUpgradeStore.getState().reset();
      }),
      listen<string>("smp-device-disconnected", () => {
        const { ui } = useDevicesStore.getState();
        if (ui.connectionState === "idle" || ui.connectionState === "connecting") return;
        setConnectionState("idle");
        setStep("scan");
        setError("Device disconnected unexpectedly");
        useProvisioningStore.getState().reset();
        useUpgradeStore.getState().reset();
      }),
    ];

    return () => {
      unlistenPromises.forEach((p) => p.then((unlisten) => unlisten()));
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Cleanup on unmount: stop scan, disconnect, reset stores
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
    <div className={`flex flex-col h-full ${bgPrimary}`}>
      {/* Top bar */}
      <div className="flex items-center gap-2 px-4 py-2 border-b border-[color:var(--border-default)]">
        <Cpu className={`${iconMd} text-sky-400`} />
        <span className={`text-sm font-medium ${textPrimary}`}>Devices</span>
        {connectionState === "connected" && selectedDeviceName && (
          <span className={`text-xs ${textSecondary} ml-auto`}>
            {selectedDeviceName}
          </span>
        )}
        {connectionState === "connected" && (
          <StatusIndicator statusCode={2} />
        )}
      </div>

      {/* Step content */}
      <div className="flex-1 overflow-y-auto">
        {step === "scan" && <DevicesScanView />}
        {step === "credentials" && <CredentialsView />}
        {step === "provisioning" && <ProvisioningView />}
        {step === "provision-complete" && <ProvisionCompleteView />}
        {step === "inspect" && <InspectView />}
        {step === "upload" && <UploadView />}
        {step === "upgrade-complete" && <UpgradeCompleteView />}
      </div>
    </div>
  );
}
