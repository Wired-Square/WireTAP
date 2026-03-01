// ui/src/apps/devices/components/CredentialsView.tsx
//
// WiFi credentials entry form. Adapted from provisioning/components/CredentialsView
// to work within the unified Devices wizard.

import { useState } from "react";
import { Wifi, Trash2, WifiOff, Eye, EyeOff, Send } from "lucide-react";
import { textSecondary, textDanger, alertInfo, alertDanger, iconMd } from "../../../styles";
import { FormField, Input, Select, PrimaryButton, SecondaryButton, DangerButton } from "../../../components/forms";
import { useProvisioningStore } from "../../provisioning/stores/provisioningStore";
import { useDevicesStore } from "../stores/devicesStore";
import StatusIndicator from "./StatusIndicator";
import FirmwareSection from "./FirmwareSection";
import {
  bleDisconnect,
  bleDeleteAllCredentials,
  bleWifiDisconnect,
  bleReadDeviceState,
  SECURITY_OPEN,
  SECURITY_WPA2_PSK,
} from "../../../api/bleProvision";

export default function CredentialsView() {
  const ssid = useProvisioningStore((s) => s.data.ssid);
  const passphrase = useProvisioningStore((s) => s.data.passphrase);
  const security = useProvisioningStore((s) => s.data.security);
  const deviceSsid = useProvisioningStore((s) => s.data.deviceSsid);
  const deviceStatus = useProvisioningStore((s) => s.data.deviceStatus);
  const deviceIpAddress = useProvisioningStore((s) => s.data.deviceIpAddress);
  const provError = useProvisioningStore((s) => s.ui.error);

  const setSsid = useProvisioningStore((s) => s.setSsid);
  const setPassphrase = useProvisioningStore((s) => s.setPassphrase);
  const setSecurity = useProvisioningStore((s) => s.setSecurity);
  const setProvisionConnectionState = useProvisioningStore((s) => s.setConnectionState);
  const setProvisionError = useProvisioningStore((s) => s.setError);
  const setDeviceSsid = useProvisioningStore((s) => s.setDeviceSsid);
  const setDeviceStatus = useProvisioningStore((s) => s.setDeviceStatus);

  const selectedDeviceId = useDevicesStore((s) => s.data.selectedDeviceId);
  const selectedDeviceName = useDevicesStore((s) => s.data.selectedDeviceName);
  const selectedDeviceCapabilities = useDevicesStore((s) => s.data.selectedDeviceCapabilities);
  const setStep = useDevicesStore((s) => s.setStep);
  const setConnectionState = useDevicesStore((s) => s.setConnectionState);

  const [deletingCredentials, setDeletingCredentials] = useState(false);
  const [disconnectingWifi, setDisconnectingWifi] = useState(false);
  const [showPassphrase, setShowPassphrase] = useState(false);

  const hasSmpCapability = selectedDeviceCapabilities.includes("smp");

  // Use either provisioning error or devices error
  const error = provError || useDevicesStore((s) => s.ui.error);

  const handleDeleteAllCredentials = async () => {
    setDeletingCredentials(true);
    setProvisionError(null);
    try {
      await bleDeleteAllCredentials();
      const state = await bleReadDeviceState();
      setDeviceSsid(state.ssid);
      setDeviceStatus(state.status);
    } catch (e) {
      setProvisionError(String(e));
    }
    setDeletingCredentials(false);
  };

  const handleWifiDisconnect = async () => {
    setDisconnectingWifi(true);
    setProvisionError(null);
    try {
      await bleWifiDisconnect();
      const state = await bleReadDeviceState();
      setDeviceSsid(state.ssid);
      setDeviceStatus(state.status);
    } catch (e) {
      setProvisionError(String(e));
    }
    setDisconnectingWifi(false);
  };

  const handleBack = async () => {
    try {
      await bleDisconnect();
    } catch {
      // Ignore
    }
    setConnectionState("idle");
    setProvisionConnectionState("idle");
    useProvisioningStore.getState().reset();
    setStep("scan");
  };

  const handleProvision = async () => {
    if (!ssid.trim()) {
      setProvisionError("SSID is required");
      return;
    }
    if (security !== SECURITY_OPEN && !passphrase.trim()) {
      setProvisionError("Passphrase is required for WPA2-PSK");
      return;
    }
    setProvisionError(null);

    // Verify BLE connection is still alive before attempting to provision
    try {
      await bleReadDeviceState();
    } catch {
      setProvisionError("Connection to device was lost. Please go back and reconnect.");
      setConnectionState("idle");
      setProvisionConnectionState("idle");
      return;
    }

    setStep("provisioning");
  };

  const isOpen = security === SECURITY_OPEN;
  const canProvision = ssid.trim().length > 0 && (isOpen || passphrase.trim().length > 0);

  return (
    <div className="flex flex-col gap-3 p-4 h-full overflow-y-auto">
      {/* Device WiFi status */}
      {deviceStatus !== undefined && (
        <div className="flex items-center gap-2 py-1.5 text-xs">
          <span className={textSecondary}>WiFi:</span>
          <StatusIndicator statusCode={deviceStatus} />
          {deviceIpAddress && (
            <>
              <span className={textSecondary}>·</span>
              <span className={textSecondary}>{deviceIpAddress}</span>
            </>
          )}
        </div>
      )}

      {/* Current device WiFi network */}
      {deviceSsid && (
        <div className={`${alertInfo} text-sm`}>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Wifi className={`${iconMd} text-blue-500`} />
              <span>
                Current device WiFi: <strong>{deviceSsid}</strong>
              </span>
            </div>
            <SecondaryButton onClick={handleWifiDisconnect} disabled={disconnectingWifi}>
              <span className="flex items-center gap-1">
                <WifiOff className={iconMd} />
                {disconnectingWifi ? "..." : "Disconnect WiFi"}
              </span>
            </SecondaryButton>
          </div>
        </div>
      )}

      {/* Error */}
      {error && (
        <div className={`${alertDanger} ${textDanger} text-sm`}>
          {error}
        </div>
      )}

      {/* SSID field */}
      <FormField label="WiFi SSID" required>
        <Input
          value={ssid}
          onChange={(e) => setSsid(e.target.value)}
          placeholder="Enter WiFi network name"
          maxLength={32}
          className="h-10"
        />
      </FormField>

      {/* Passphrase + Security type on same row */}
      <div className="flex gap-3 items-end">
        {!isOpen && (
          <FormField label="Passphrase" required className="flex-1 min-w-0">
            <div className="relative">
              <Input
                type={showPassphrase ? "text" : "password"}
                value={passphrase}
                onChange={(e) => setPassphrase(e.target.value)}
                placeholder="Enter WiFi passphrase"
                maxLength={64}
                className="h-10 pr-10"
              />
              <button
                type="button"
                onClick={() => setShowPassphrase((v) => !v)}
                className="absolute right-2 top-1/2 -translate-y-1/2 p-1 cursor-pointer text-[color:var(--text-secondary)] hover:text-[color:var(--text-primary)] transition-colors"
                tabIndex={-1}
              >
                {showPassphrase ? <EyeOff className={iconMd} /> : <Eye className={iconMd} />}
              </button>
            </div>
          </FormField>
        )}
        <FormField label="Security Type" className="w-44 shrink-0">
          <Select
            value={security}
            onChange={(e) => setSecurity(Number(e.target.value))}
            className="h-10"
          >
            <option value={SECURITY_WPA2_PSK}>WPA2-PSK</option>
            <option value={SECURITY_OPEN}>Open</option>
          </Select>
        </FormField>
      </div>

      {/* Delete all credentials + Provision */}
      <div className="flex items-center justify-between pt-1">
        <DangerButton onClick={handleDeleteAllCredentials} disabled={deletingCredentials} className="min-w-[20rem]">
          <span className="flex items-center justify-center gap-1">
            <Trash2 className={iconMd} />
            {deletingCredentials ? "Deleting..." : "Delete All Credentials"}
          </span>
        </DangerButton>
        <PrimaryButton onClick={handleProvision} disabled={!canProvision} className="w-44">
          <span className="flex items-center justify-center gap-1.5">
            <Send className={iconMd} />
            Provision
          </span>
        </PrimaryButton>
      </div>

      {/* Firmware Upgrade — inline SMP section */}
      {hasSmpCapability && selectedDeviceId && (
        <FirmwareSection
          deviceId={selectedDeviceId}
          deviceName={selectedDeviceName ?? "Device"}
        />
      )}

      {/* Back button pinned to bottom */}
      <div className="mt-auto pt-4">
        <SecondaryButton onClick={handleBack}>Back</SecondaryButton>
      </div>
    </div>
  );
}
