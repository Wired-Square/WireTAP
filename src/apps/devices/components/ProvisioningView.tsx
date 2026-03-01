// ui/src/apps/devices/components/ProvisioningView.tsx
//
// Shows progress while writing WiFi credentials to the device.
// Adapted from provisioning/components/ProvisioningView to route to
// "provision-complete" step instead of "complete".

import { useEffect, useRef } from "react";
import { Check, Loader2 } from "lucide-react";
import { textPrimary, textSecondary } from "../../../styles";
import { iconMd } from "../../../styles/spacing";
import { SecondaryButton } from "../../../components/forms";
import { useProvisioningStore } from "../../provisioning/stores/provisioningStore";
import { useDevicesStore } from "../stores/devicesStore";
import {
  bleProvisionWifi,
  bleDisconnect,
  SECURITY_OPEN,
} from "../../../api/bleProvision";
import { tlog } from "../../../api/settings";
import StatusIndicator from "./StatusIndicator";

export default function ProvisioningView() {
  const ssid = useProvisioningStore((s) => s.data.ssid);
  const passphrase = useProvisioningStore((s) => s.data.passphrase);
  const security = useProvisioningStore((s) => s.data.security);
  const provisionState = useProvisioningStore((s) => s.ui.provisionState);
  const statusMessage = useProvisioningStore((s) => s.ui.statusMessage);
  const error = useProvisioningStore((s) => s.ui.error);

  const setProvisionState = useProvisioningStore((s) => s.setProvisionState);
  const setStatusMessage = useProvisioningStore((s) => s.setStatusMessage);
  const setProvisionError = useProvisioningStore((s) => s.setError);
  const setProvisionConnectionState = useProvisioningStore((s) => s.setConnectionState);

  const setStep = useDevicesStore((s) => s.setStep);
  const setConnectionState = useDevicesStore((s) => s.setConnectionState);

  const startedRef = useRef(false);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;

    const doProvision = async () => {
      tlog.info(`[provision] Starting: ssid="${ssid}", security=${security}, hasPassphrase=${!!passphrase}`);
      setProvisionState("writing");
      setStatusMessage("Writing credentials to device...");
      setProvisionError(null);

      try {
        await bleProvisionWifi({
          ssid,
          passphrase: security === SECURITY_OPEN ? null : passphrase || null,
          security,
        });

        tlog.info("[provision] Credentials written, waiting for device status...");
        setProvisionState("waiting");
        setStatusMessage("Waiting for device to connect to WiFi...");
      } catch (e) {
        tlog.info(`[provision] Failed: ${String(e)}`);
        setProvisionState("error");
        setProvisionError(String(e));
        setStatusMessage(null);
      }
    };

    doProvision();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Route to provision-complete when done
  useEffect(() => {
    if (provisionState === "connected" || provisionState === "error") {
      setStep("provision-complete");
    }
  }, [provisionState, setStep]);

  // Timeout: if stuck in "waiting" for 30s, error out
  useEffect(() => {
    if (provisionState !== "waiting") return;
    const timer = setTimeout(() => {
      const current = useProvisioningStore.getState();
      if (current.ui.provisionState === "waiting") {
        setProvisionState("error");
        setProvisionError("Timed out waiting for device to connect to WiFi");
      }
    }, 30_000);
    return () => clearTimeout(timer);
  }, [provisionState, setProvisionState, setProvisionError]);

  const handleCancel = async () => {
    try {
      await bleDisconnect();
    } catch {
      // Ignore
    }
    setConnectionState("idle");
    setProvisionConnectionState("idle");
    setProvisionState("idle");
    setStep("scan");
  };

  const steps = [
    { label: "Writing SSID", done: provisionState !== "idle" },
    {
      label: security === SECURITY_OPEN ? "Skipping passphrase (open)" : "Writing passphrase",
      done: provisionState !== "idle",
    },
    { label: "Sending connect command", done: provisionState === "waiting" },
    { label: "Waiting for device", done: false },
  ];

  return (
    <div className="flex flex-col items-center gap-6 p-8 h-full">
      {/* Spinner */}
      <Loader2 className="w-12 h-12 text-sky-500 animate-spin" />

      {/* Progress steps */}
      <div className="flex flex-col gap-2 w-full max-w-sm">
        {steps.map((step, i) => {
          const isActive =
            (i === 3 && provisionState === "waiting") ||
            (i < 3 && provisionState === "writing");
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

      {/* Status message */}
      {statusMessage && (
        <div className={`text-sm ${textSecondary}`}>{statusMessage}</div>
      )}

      {/* Error */}
      {error && (
        <div className="p-3 text-sm text-red-600 bg-red-50 rounded-lg border border-red-200 w-full max-w-sm">
          {error}
        </div>
      )}

      {/* Current status badge */}
      {provisionState === "waiting" && (
        <StatusIndicator statusCode={1} />
      )}

      {/* Cancel */}
      <SecondaryButton onClick={handleCancel}>Cancel</SecondaryButton>
    </div>
  );
}
