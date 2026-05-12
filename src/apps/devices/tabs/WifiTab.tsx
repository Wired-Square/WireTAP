// ui/src/apps/devices/tabs/WifiTab.tsx
//
// Wi-Fi provisioning tab. Combines what used to be three step views
// (credentials form, in-progress, complete/failed) into one tab with local
// React state for the sub-phase.

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Check,
  CheckCircle,
  Eye,
  EyeOff,
  Loader2,
  Send,
  Trash2,
  Wifi,
  WifiOff,
  XCircle,
} from "lucide-react";
import {
  alertDanger,
  alertInfo,
  alertSuccess,
  iconMd,
  textDanger,
  textPrimary,
  textSecondary,
} from "../../../styles";
import {
  DangerButton,
  FormField,
  Input,
  PrimaryButton,
  Select,
  SecondaryButton,
} from "../../../components/forms";
import { useDevicesStore } from "../stores/devicesStore";
import { useProvisioningStore } from "../../provisioning/stores/provisioningStore";
import { useDeviceConnection } from "../hooks/useDeviceConnection";
import StatusIndicator from "../components/StatusIndicator";
import {
  bleDeleteAllCredentials,
  bleProvisionWifi,
  bleReadDeviceState,
  bleWifiDisconnect,
  SECURITY_OPEN,
  SECURITY_WPA2_PSK,
} from "../../../api/bleProvision";
import { tlog } from "../../../api/settings";

type WifiPhase = "form" | "writing" | "result";

export default function WifiTab() {
  const { t } = useTranslation("devices");
  const ssid = useProvisioningStore((s) => s.data.ssid);
  const passphrase = useProvisioningStore((s) => s.data.passphrase);
  const security = useProvisioningStore((s) => s.data.security);
  const deviceSsid = useProvisioningStore((s) => s.data.deviceSsid);
  const deviceStatus = useProvisioningStore((s) => s.data.deviceStatus);
  const deviceIpAddress = useProvisioningStore((s) => s.data.deviceIpAddress);
  const provisionState = useProvisioningStore((s) => s.ui.provisionState);
  const statusMessage = useProvisioningStore((s) => s.ui.statusMessage);
  const provError = useProvisioningStore((s) => s.ui.error);

  const setSsid = useProvisioningStore((s) => s.setSsid);
  const setPassphrase = useProvisioningStore((s) => s.setPassphrase);
  const setSecurity = useProvisioningStore((s) => s.setSecurity);
  const setProvisionError = useProvisioningStore((s) => s.setError);
  const setProvisionState = useProvisioningStore((s) => s.setProvisionState);
  const setStatusMessage = useProvisioningStore((s) => s.setStatusMessage);
  const setDeviceSsid = useProvisioningStore((s) => s.setDeviceSsid);
  const setDeviceStatus = useProvisioningStore((s) => s.setDeviceStatus);

  const setActiveTab = useDevicesStore((s) => s.setActiveTab);
  const selectedCapabilities = useDevicesStore((s) => s.data.selectedCapabilities);
  const selectedBleId = useDevicesStore((s) => s.data.selectedBleId);
  const transports = useDevicesStore((s) => s.ui.transports);
  const setError = useDevicesStore((s) => s.setError);

  const { ensureBleProv } = useDeviceConnection();

  const [phase, setPhase] = useState<WifiPhase>("form");
  const [showPassphrase, setShowPassphrase] = useState(false);
  const [deletingCredentials, setDeletingCredentials] = useState(false);
  const [disconnectingWifi, setDisconnectingWifi] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);
  const startedRef = useRef(false);

  // Bring up BLE provisioning when this tab activates.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        await ensureBleProv();
      } catch (e) {
        if (!cancelled) setConnectError(String(e));
      }
    })();
    return () => { cancelled = true; };
  }, [ensureBleProv]);

  // Move to the result phase once provisioning finishes.
  useEffect(() => {
    if (provisionState === "connected" || provisionState === "error") {
      setPhase("result");
    }
  }, [provisionState]);

  const isOpen = security === SECURITY_OPEN;
  const canProvision = ssid.trim().length > 0 && (isOpen || passphrase.trim().length > 0);

  const handleDeleteAllCredentials = async () => {
    if (!selectedBleId) return;
    setDeletingCredentials(true);
    setProvisionError(null);
    try {
      await bleDeleteAllCredentials(selectedBleId);
      const state = await bleReadDeviceState(selectedBleId);
      setDeviceSsid(state.ssid);
      setDeviceStatus(state.status);
    } catch (e) {
      setProvisionError(String(e));
    }
    setDeletingCredentials(false);
  };

  const handleWifiDisconnect = async () => {
    if (!selectedBleId) return;
    setDisconnectingWifi(true);
    setProvisionError(null);
    try {
      await bleWifiDisconnect(selectedBleId);
      const state = await bleReadDeviceState(selectedBleId);
      setDeviceSsid(state.ssid);
      setDeviceStatus(state.status);
    } catch (e) {
      setProvisionError(String(e));
    }
    setDisconnectingWifi(false);
  };

  const beginProvision = async () => {
    if (!selectedBleId) return;
    if (!ssid.trim()) {
      setProvisionError(t("credentials.errors.ssidRequired"));
      return;
    }
    if (!isOpen && !passphrase.trim()) {
      setProvisionError(t("credentials.errors.passphraseRequired"));
      return;
    }

    // Make sure BLE is still alive before kicking off.
    try {
      await bleReadDeviceState(selectedBleId);
    } catch {
      setProvisionError(t("credentials.errors.connectionLost"));
      return;
    }

    setProvisionError(null);
    setError(null);
    setPhase("writing");
    startedRef.current = true;

    tlog.info(
      `[provision] Starting: ssid="${ssid}", security=${security}, hasPassphrase=${!!passphrase}`,
    );
    setProvisionState("writing");
    setStatusMessage(t("provisioning.writingCredentials"));
    try {
      await bleProvisionWifi(selectedBleId, {
        ssid,
        passphrase: isOpen ? null : passphrase || null,
        security,
      });
      tlog.info("[provision] Credentials accepted by device.");
      // bleProvisionWifi resolves Ok only after SAVE_CONNECT-ack; commit
      // success here if the Status::Connected notification didn't beat
      // us through the ble-provision-status listener.
      if (useProvisioningStore.getState().ui.provisionState === "writing") {
        setProvisionState("connected");
      }
    } catch (e) {
      tlog.info(`[provision] Failed: ${String(e)}`);
      setProvisionState("error");
      setProvisionError(String(e));
      setStatusMessage(null);
    }
  };

  const handleRetry = () => {
    setProvisionState("idle");
    setProvisionError(null);
    setStatusMessage(null);
    setPhase("form");
  };

  // ── Connection failure short-circuit ─────────────────────────────────────
  if (connectError && !transports.bleProv) {
    return (
      <div className="p-4">
        <div className={`${alertDanger} ${textDanger} text-sm`}>{connectError}</div>
      </div>
    );
  }

  // ── Phase: provisioning in progress ──────────────────────────────────────
  if (phase === "writing") {
    const steps = [
      { label: t("provisioning.steps.writingSsid"), done: provisionState !== "idle" },
      {
        label: isOpen
          ? t("provisioning.steps.skippingPassphrase")
          : t("provisioning.steps.writingPassphrase"),
        done: provisionState !== "idle",
      },
      { label: t("provisioning.steps.sendingConnect"), done: false },
      { label: t("provisioning.steps.waitingForDevice"), done: false },
    ];

    return (
      <div className="flex flex-col items-center gap-6 p-8 h-full">
        <Loader2 className="w-12 h-12 text-sky-500 animate-spin" />
        <div className="flex flex-col gap-2 w-full max-w-sm">
          {steps.map((step, i) => {
            const isActive = !step.done && provisionState === "writing";
            return (
              <div key={i} className={`flex items-center gap-2 text-sm ${textPrimary}`}>
                {step.done ? (
                  <Check className={`${iconMd} text-green-500 shrink-0`} />
                ) : isActive ? (
                  <Loader2 className={`${iconMd} text-sky-500 animate-spin shrink-0`} />
                ) : (
                  <div className="w-4 h-4 rounded-full border border-[color:var(--border-default)] shrink-0" />
                )}
                <span className={step.done ? "" : isActive ? "font-medium" : textSecondary}>
                  {step.label}
                </span>
              </div>
            );
          })}
        </div>
        {statusMessage && <div className={`text-sm ${textSecondary}`}>{statusMessage}</div>}
        {provError && (
          <div className={`${alertDanger} ${textDanger} text-sm w-full max-w-sm`}>{provError}</div>
        )}
      </div>
    );
  }

  // ── Phase: result (success / failure) ────────────────────────────────────
  if (phase === "result") {
    const isSuccess = provisionState === "connected";
    const hasSmpCapability = selectedCapabilities.includes("smp");

    return (
      <div className="flex flex-col items-center gap-6 p-8 h-full">
        {isSuccess ? (
          <>
            <CheckCircle className="w-16 h-16 text-green-500" />
            <div className={`text-lg font-medium ${textPrimary}`}>
              {t("complete.wifiConnected")}
            </div>
            <div className={`${alertSuccess} w-full max-w-sm text-sm`}>
              <div className="space-y-1">
                <div>
                  <span className={textSecondary}>{t("complete.networkLabel")}</span>{" "}
                  <span className="font-medium">{ssid}</span>
                </div>
                <div>
                  <span className={textSecondary}>{t("complete.securityLabel")}</span>{" "}
                  <span className="font-medium">
                    {security === SECURITY_OPEN
                      ? t("complete.open")
                      : security === SECURITY_WPA2_PSK
                        ? t("complete.wpa2Psk")
                        : t("complete.securityType", { n: security })}
                  </span>
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
              <SecondaryButton onClick={handleRetry}>{t("device.changeWifi")}</SecondaryButton>
              {hasSmpCapability && (
                <PrimaryButton onClick={() => setActiveTab("firmware")}>
                  {t("device.goToFirmware")}
                </PrimaryButton>
              )}
            </div>
          </>
        ) : (
          <>
            <XCircle className="w-16 h-16 text-red-500" />
            <div className={`text-lg font-medium ${textPrimary}`}>
              {t("complete.failedTitle")}
            </div>
            {provError && (
              <div className={`${alertDanger} w-full max-w-sm text-sm`}>{provError}</div>
            )}
            <div className="flex gap-3 mt-4">
              <PrimaryButton onClick={handleRetry}>{t("complete.retry")}</PrimaryButton>
            </div>
          </>
        )}
      </div>
    );
  }

  // ── Phase: form ──────────────────────────────────────────────────────────
  return (
    <div className="flex flex-col gap-3 p-4 h-full overflow-y-auto">
      {!transports.bleProv && (
        <div className={`flex items-center gap-2 text-sm ${textSecondary}`}>
          <Loader2 className={`${iconMd} animate-spin`} />
          {t("device.connectingBle")}
        </div>
      )}

      {deviceStatus !== undefined && (
        <div className="flex items-center gap-2 py-1.5 text-xs">
          <span className={textSecondary}>{t("credentials.wifiLabel")}</span>
          <StatusIndicator statusCode={deviceStatus} />
          {deviceIpAddress && (
            <>
              <span className={textSecondary}>·</span>
              <span className={textSecondary}>{deviceIpAddress}</span>
            </>
          )}
        </div>
      )}

      {deviceSsid && (
        <div className={`${alertInfo} text-sm`}>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Wifi className={`${iconMd} text-blue-500`} />
              <span>
                {t("credentials.currentDeviceWifi")} <strong>{deviceSsid}</strong>
              </span>
            </div>
            <SecondaryButton onClick={handleWifiDisconnect} disabled={disconnectingWifi}>
              <span className="flex items-center gap-1">
                <WifiOff className={iconMd} />
                {disconnectingWifi ? "..." : t("credentials.disconnectWifi")}
              </span>
            </SecondaryButton>
          </div>
        </div>
      )}

      {provError && (
        <div className={`${alertDanger} ${textDanger} text-sm`}>{provError}</div>
      )}

      <FormField label={t("credentials.ssidLabel")} required>
        <Input
          value={ssid}
          onChange={(e) => setSsid(e.target.value)}
          placeholder={t("credentials.ssidPlaceholder")}
          maxLength={32}
          className="h-10"
        />
      </FormField>

      <div className="flex gap-3 items-end">
        {!isOpen && (
          <FormField label={t("credentials.passphraseLabel")} required className="flex-1 min-w-0">
            <div className="relative">
              <Input
                type={showPassphrase ? "text" : "password"}
                value={passphrase}
                onChange={(e) => setPassphrase(e.target.value)}
                placeholder={t("credentials.passphrasePlaceholder")}
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
        <FormField label={t("credentials.securityType")} className="w-44 shrink-0">
          <Select
            value={security}
            onChange={(e) => setSecurity(Number(e.target.value))}
            className="h-10"
          >
            <option value={SECURITY_WPA2_PSK}>{t("credentials.wpa2Psk")}</option>
            <option value={SECURITY_OPEN}>{t("credentials.open")}</option>
          </Select>
        </FormField>
      </div>

      <div className="flex items-center justify-between pt-1">
        <DangerButton
          onClick={handleDeleteAllCredentials}
          disabled={deletingCredentials || !transports.bleProv}
          className="min-w-[20rem]"
        >
          <span className="flex items-center justify-center gap-1">
            <Trash2 className={iconMd} />
            {deletingCredentials ? t("credentials.deleting") : t("credentials.deleteAll")}
          </span>
        </DangerButton>
        <PrimaryButton
          onClick={beginProvision}
          disabled={!canProvision || !transports.bleProv}
          className="w-44"
        >
          <span className="flex items-center justify-center gap-1.5">
            <Send className={iconMd} />
            {t("credentials.provision")}
          </span>
        </PrimaryButton>
      </div>
    </div>
  );
}
