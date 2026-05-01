// ui/src/apps/devices/components/ProvisionCompleteView.tsx
//
// Shown after WiFi provisioning completes (success or failure). If the device
// also supports SMP firmware upgrade, offers a "Continue to Firmware Upgrade"
// button that transitions to the inspect step without disconnecting.

import { CheckCircle, XCircle, Bluetooth } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { textPrimary, textSecondary } from "../../../styles";
import { alertSuccess, alertDanger } from "../../../styles/cardStyles";
import { iconMd } from "../../../styles/spacing";
import { PrimaryButton, SecondaryButton } from "../../../components/forms";
import { useProvisioningStore } from "../../provisioning/stores/provisioningStore";
import { useUpgradeStore } from "../../upgrade/stores/upgradeStore";
import { useDevicesStore } from "../stores/devicesStore";
import {
  bleDisconnect,
  bleReadDeviceState,
  SECURITY_OPEN,
  SECURITY_WPA2_PSK,
} from "../../../api/bleProvision";
import {
  smpConnectBle,
  smpListImages,
} from "../../../api/smpUpgrade";

export default function ProvisionCompleteView() {
  const { t } = useTranslation("devices");

  const securityLabel = (security: number): string => {
    switch (security) {
      case SECURITY_OPEN:
        return t("complete.open");
      case SECURITY_WPA2_PSK:
        return t("complete.wpa2Psk");
      default:
        return t("complete.securityType", { n: security });
    }
  };

  const provisionState = useProvisioningStore((s) => s.ui.provisionState);
  const provError = useProvisioningStore((s) => s.ui.error);
  const ssid = useProvisioningStore((s) => s.data.ssid);
  const security = useProvisioningStore((s) => s.data.security);
  const deviceIpAddress = useProvisioningStore((s) => s.data.deviceIpAddress);

  const selectedDeviceName = useDevicesStore((s) => s.data.selectedDeviceName);
  const selectedDeviceId = useDevicesStore((s) => s.data.selectedDeviceId);
  const selectedDeviceCapabilities = useDevicesStore((s) => s.data.selectedDeviceCapabilities);

  const setStep = useDevicesStore((s) => s.setStep);
  const setConnectionState = useDevicesStore((s) => s.setConnectionState);
  const setDevicesError = useDevicesStore((s) => s.setError);

  const setProvisionState = useProvisioningStore((s) => s.setProvisionState);
  const setProvisionError = useProvisioningStore((s) => s.setError);
  const setProvisionConnectionState = useProvisioningStore((s) => s.setConnectionState);

  const setUpgradeSelectedDevice = useUpgradeStore((s) => s.setSelectedDevice);
  const setUpgradeConnectionState = useUpgradeStore((s) => s.setConnectionState);
  const setImages = useUpgradeStore((s) => s.setImages);

  const [upgradingTransition, setUpgradingTransition] = useState(false);

  const isSuccess = provisionState === "connected";
  const hasSmpCapability = selectedDeviceCapabilities.includes("smp");

  const handleDisconnect = async () => {
    try {
      await bleDisconnect();
    } catch {
      // Ignore
    }
    setConnectionState("idle");
    setProvisionConnectionState("idle");
    useProvisioningStore.getState().reset();
    useUpgradeStore.getState().reset();
    setStep("scan");
  };

  const handleProvisionAnother = async () => {
    try {
      await bleDisconnect();
    } catch {
      // Ignore
    }
    setConnectionState("idle");
    useProvisioningStore.getState().reset();
    useUpgradeStore.getState().reset();
    useDevicesStore.getState().reset();
  };

  const handleRetry = async () => {
    // Verify the BLE connection is still alive before going back to credentials
    try {
      await bleReadDeviceState();
      setProvisionState("idle");
      setProvisionError(null);
      setProvisionConnectionState("connected");
      setStep("credentials");
    } catch {
      try { await bleDisconnect(); } catch { /* ignore */ }
      setConnectionState("idle");
      useProvisioningStore.getState().reset();
      useDevicesStore.getState().reset();
      setDevicesError(t("complete.connectionLost"));
    }
  };

  /** Transition to firmware upgrade — connect via SMP and go to inspect. */
  const handleContinueToUpgrade = async () => {
    if (!selectedDeviceId) return;
    setUpgradingTransition(true);
    setDevicesError(null);

    try {
      // Disconnect the BLE provisioning connection
      try {
        await bleDisconnect();
      } catch {
        // Ignore
      }

      // Connect via SMP
      await smpConnectBle(selectedDeviceId);
      setUpgradeSelectedDevice(selectedDeviceId, selectedDeviceName, "ble");
      setUpgradeConnectionState("connected");

      // Read image slots
      try {
        const images = await smpListImages();
        setImages(images);
      } catch {
        // Non-critical
      }

      if (useDevicesStore.getState().ui.connectionState !== "connected") return;
      setStep("inspect");
    } catch (e) {
      setDevicesError(String(e));
    } finally {
      setUpgradingTransition(false);
    }
  };

  return (
    <div className="flex flex-col items-center gap-6 p-8 h-full">
      {isSuccess ? (
        <>
          <CheckCircle className="w-16 h-16 text-green-500" />
          <div className={`text-lg font-medium ${textPrimary}`}>{t("complete.wifiConnected")}</div>

          <div className={`${alertSuccess} w-full max-w-sm text-sm`}>
            <div className="space-y-1">
              {selectedDeviceName && (
                <div>
                  <span className={textSecondary}>{t("complete.deviceLabel")}</span>{" "}
                  <span className="font-medium">{selectedDeviceName}</span>
                </div>
              )}
              <div>
                <span className={textSecondary}>{t("complete.networkLabel")}</span>{" "}
                <span className="font-medium">{ssid}</span>
              </div>
              <div>
                <span className={textSecondary}>{t("complete.securityLabel")}</span>{" "}
                <span className="font-medium">{securityLabel(security)}</span>
              </div>
              {deviceIpAddress && (
                <div>
                  <span className={textSecondary}>{t("complete.ipAddressLabel")}</span>{" "}
                  <span className="font-medium">{deviceIpAddress}</span>
                </div>
              )}
            </div>
          </div>

          <div className="flex gap-3 mt-4">
            <SecondaryButton onClick={handleDisconnect}>{t("complete.disconnect")}</SecondaryButton>
            <PrimaryButton onClick={handleProvisionAnother}>{t("complete.provisionAnother")}</PrimaryButton>
          </div>

          {/* Firmware Upgrade — only shown if device has SMP capability */}
          {hasSmpCapability && (
            <div className="w-full max-w-sm pt-4 border-t border-[color:var(--border-default)]">
              <div className={`text-sm font-medium mb-3 ${textPrimary}`}>{t("complete.firmwareUpgrade")}</div>
              <PrimaryButton
                onClick={handleContinueToUpgrade}
                disabled={upgradingTransition}
                className="w-full"
              >
                <span className="flex items-center justify-center gap-1.5">
                  <Bluetooth className={iconMd} />
                  {upgradingTransition ? t("complete.connecting") : t("complete.continueToUpgrade")}
                </span>
              </PrimaryButton>
            </div>
          )}
        </>
      ) : (
        <>
          <XCircle className="w-16 h-16 text-red-500" />
          <div className={`text-lg font-medium ${textPrimary}`}>{t("complete.failedTitle")}</div>

          {provError && (
            <div className={`${alertDanger} w-full max-w-sm text-sm`}>
              {provError}
            </div>
          )}

          <div className="flex gap-3 mt-4">
            <SecondaryButton onClick={handleDisconnect}>{t("complete.disconnect")}</SecondaryButton>
            <PrimaryButton onClick={handleRetry}>{t("complete.retry")}</PrimaryButton>
          </div>
        </>
      )}
    </div>
  );
}
