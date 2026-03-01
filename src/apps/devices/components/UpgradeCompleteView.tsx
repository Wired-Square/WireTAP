// ui/src/apps/devices/components/UpgradeCompleteView.tsx
//
// Shown after firmware upgrade completes. Adapted from upgrade/components/CompleteView
// to reset to scan step instead of navigating sections.

import { useState } from "react";
import { CheckCircle, XCircle, RefreshCw } from "lucide-react";
import { textPrimary, textSecondary } from "../../../styles";
import { iconMd } from "../../../styles/spacing";
import { alertSuccess, alertDanger } from "../../../styles/cardStyles";
import { PrimaryButton, SecondaryButton } from "../../../components/forms";
import { useUpgradeStore } from "../../upgrade/stores/upgradeStore";
import { useDevicesStore } from "../stores/devicesStore";
import { useProvisioningStore } from "../../provisioning/stores/provisioningStore";
import {
  smpConnectBle,
  smpConnectUdp,
  smpListImages,
  smpConfirmImage,
  smpDisconnect,
} from "../../../api/smpUpgrade";

export default function UpgradeCompleteView() {
  const uploadState = useUpgradeStore((s) => s.ui.uploadState);
  const error = useUpgradeStore((s) => s.ui.error);
  const selectedDeviceId = useUpgradeStore((s) => s.data.selectedDeviceId);
  const selectedDeviceName = useUpgradeStore((s) => s.data.selectedDeviceName);
  const selectedDeviceTransport = useUpgradeStore((s) => s.data.selectedDeviceTransport);

  const setUploadState = useUpgradeStore((s) => s.setUploadState);
  const setUpgradeError = useUpgradeStore((s) => s.setError);
  const setUpgradeConnectionState = useUpgradeStore((s) => s.setConnectionState);
  const setImages = useUpgradeStore((s) => s.setImages);

  const setStep = useDevicesStore((s) => s.setStep);
  const setConnectionState = useDevicesStore((s) => s.setConnectionState);

  const [confirming, setConfirming] = useState(false);

  const isSuccess = uploadState !== "error";

  const handleDone = async () => {
    try {
      await smpDisconnect();
    } catch {
      // Ignore
    }
    setConnectionState("idle");
    useUpgradeStore.getState().reset();
    useProvisioningStore.getState().reset();
    useDevicesStore.getState().reset();
  };

  const handleReconnectAndConfirm = async () => {
    if (!selectedDeviceId) return;
    setConfirming(true);
    setUpgradeError(null);

    try {
      // Reconnect to the device after reboot
      if (selectedDeviceTransport === "udp" && selectedDeviceId.startsWith("udp:")) {
        const parts = selectedDeviceId.split(":");
        const address = parts.slice(1, -1).join(":");
        const port = parseInt(parts[parts.length - 1], 10);
        await smpConnectUdp(address, port);
      } else {
        await smpConnectBle(selectedDeviceId);
      }
      setUpgradeConnectionState("connected");

      // Read image slots to find the test image
      const images = await smpListImages();
      setImages(images);

      // Find the active image to confirm
      const activeImage = images.find((img) => img.active && !img.confirmed);
      if (activeImage) {
        const hashBytes = [];
        for (let i = 0; i < activeImage.hash.length; i += 2) {
          hashBytes.push(parseInt(activeImage.hash.slice(i, i + 2), 16));
        }
        await smpConfirmImage(hashBytes);
        setUploadState("confirming");
      } else {
        setUploadState("confirming");
      }
    } catch (e) {
      setUpgradeError(String(e));
    } finally {
      setConfirming(false);
    }
  };

  const handleRetry = () => {
    setUploadState("idle");
    setUpgradeError(null);
    setStep("upload");
  };

  return (
    <div className="flex flex-col items-center gap-6 p-8 h-full">
      {isSuccess ? (
        <>
          <CheckCircle className="w-16 h-16 text-green-500" />
          <div className={`text-lg font-medium ${textPrimary}`}>Firmware Uploaded</div>

          <div className={`${alertSuccess} w-full max-w-sm text-sm`}>
            <div className="space-y-1">
              {selectedDeviceName && (
                <div>
                  <span className={textSecondary}>Device:</span>{" "}
                  <span className="font-medium">{selectedDeviceName}</span>
                </div>
              )}
              <div>
                <span className={textSecondary}>Status:</span>{" "}
                <span className="font-medium">
                  {uploadState === "confirming"
                    ? "Image confirmed"
                    : "Device rebooting into new firmware"}
                </span>
              </div>
            </div>
          </div>

          {uploadState !== "confirming" && (
            <div className={`text-xs ${textSecondary} max-w-sm text-center`}>
              The device is rebooting into the new firmware as a test. Reconnect
              and confirm to make it permanent, or it will revert on next reboot.
            </div>
          )}

          <div className="flex gap-3 mt-4">
            <SecondaryButton onClick={handleDone}>Done</SecondaryButton>
            {uploadState !== "confirming" && (
              <PrimaryButton onClick={handleReconnectAndConfirm} disabled={confirming}>
                <span className="flex items-center gap-1.5">
                  <RefreshCw className={`${iconMd} ${confirming ? "animate-spin" : ""}`} />
                  {confirming ? "Confirming..." : "Reconnect & Confirm"}
                </span>
              </PrimaryButton>
            )}
          </div>
        </>
      ) : (
        <>
          <XCircle className="w-16 h-16 text-red-500" />
          <div className={`text-lg font-medium ${textPrimary}`}>Upgrade Failed</div>

          {error && (
            <div className={`${alertDanger} w-full max-w-sm text-sm`}>
              {error}
            </div>
          )}

          <div className="flex gap-3 mt-4">
            <SecondaryButton onClick={handleDone}>Done</SecondaryButton>
            <PrimaryButton onClick={handleRetry}>Retry</PrimaryButton>
          </div>
        </>
      )}
    </div>
  );
}
