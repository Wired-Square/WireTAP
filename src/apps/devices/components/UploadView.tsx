// ui/src/apps/devices/components/UploadView.tsx
//
// Firmware upload progress view. Adapted from upgrade/components/UploadView
// to route to "upgrade-complete" step.

import { useRef } from "react";
import { Check, Loader2, Upload, FolderOpen, ArrowLeft } from "lucide-react";
import { textPrimary, textSecondary } from "../../../styles";
import { iconMd } from "../../../styles/spacing";
import { PrimaryButton, SecondaryButton, DangerButton } from "../../../components/forms";
import { useUpgradeStore } from "../../upgrade/stores/upgradeStore";
import { useDevicesStore } from "../stores/devicesStore";
import {
  smpUploadFirmware,
  smpTestImage,
  smpResetDevice,
  smpCancelUpload,
} from "../../../api/smpUpgrade";
import { pickFileToOpen } from "../../../api/dialogs";

function formatKB(bytes: number): string {
  return (bytes / 1024).toFixed(1);
}

export default function UploadView() {
  const selectedFilePath = useUpgradeStore((s) => s.data.selectedFilePath);
  const selectedFileName = useUpgradeStore((s) => s.data.selectedFileName);
  const selectedFileSize = useUpgradeStore((s) => s.data.selectedFileSize);
  const uploadProgress = useUpgradeStore((s) => s.data.uploadProgress);
  const uploadState = useUpgradeStore((s) => s.ui.uploadState);
  const error = useUpgradeStore((s) => s.ui.error);

  const setSelectedFile = useUpgradeStore((s) => s.setSelectedFile);
  const setUploadState = useUpgradeStore((s) => s.setUploadState);
  const setUploadProgress = useUpgradeStore((s) => s.setUploadProgress);
  const setUpgradeError = useUpgradeStore((s) => s.setError);
  const setStatusMessage = useUpgradeStore((s) => s.setStatusMessage);

  const setStep = useDevicesStore((s) => s.setStep);

  const flashingRef = useRef(false);

  const isFlashing = uploadState !== "idle" && uploadState !== "error";

  const handleBrowse = async () => {
    try {
      const result = await pickFileToOpen({
        filters: [{ name: "Firmware", extensions: ["bin"] }],
      });
      if (result) {
        const fileName = result.split("/").pop() ?? result.split("\\").pop() ?? result;
        setSelectedFile(result, fileName, null);
      }
    } catch (e) {
      setUpgradeError(String(e));
    }
  };

  const handleFlash = async () => {
    if (!selectedFilePath || flashingRef.current) return;
    flashingRef.current = true;

    setUpgradeError(null);
    setUploadProgress(null);

    try {
      // Step 1: Reading firmware file
      setUploadState("reading");
      setStatusMessage("Reading firmware file...");

      // Step 2: Uploading firmware
      setUploadState("uploading");
      setStatusMessage("Uploading firmware...");
      await smpUploadFirmware(selectedFilePath);

      const { ui } = useUpgradeStore.getState();
      if (ui.uploadState === "error") return;

      setUploadState("testing");
      setStatusMessage("Marking image for test boot...");

      // Re-read slots to find the pending image in slot 1
      const { smpListImages } = await import("../../../api/smpUpgrade");
      const images = await smpListImages();
      const pendingImage = images.find((img) => img.slot === 1 && img.pending);

      if (pendingImage) {
        const hashBytes = [];
        for (let i = 0; i < pendingImage.hash.length; i += 2) {
          hashBytes.push(parseInt(pendingImage.hash.slice(i, i + 2), 16));
        }
        await smpTestImage(hashBytes);
      }

      // Step 4: Reset device
      setUploadState("resetting");
      setStatusMessage("Resetting device...");
      await smpResetDevice();

      // Device will reboot — transition to upgrade-complete
      setStep("upgrade-complete");
    } catch (e) {
      setUploadState("error");
      setUpgradeError(String(e));
      setStatusMessage(null);
    } finally {
      flashingRef.current = false;
    }
  };

  const handleCancel = async () => {
    try {
      await smpCancelUpload();
    } catch {
      // Ignore
    }
    setUploadState("error");
    setUpgradeError("Upload cancelled");
    setStatusMessage(null);
    flashingRef.current = false;
  };

  const handleBack = () => {
    setUploadState("idle");
    setUpgradeError(null);
    setUploadProgress(null);
    setStep("inspect");
  };

  // Progress step definitions
  const steps = [
    {
      label: `Reading firmware file${selectedFileSize !== null ? ` (${formatKB(selectedFileSize)} KB)` : ""}`,
      done: uploadState !== "idle" && uploadState !== "reading",
      active: uploadState === "reading",
    },
    {
      label: `Uploading firmware${uploadProgress ? ` ${Math.round(uploadProgress.percent)}%` : ""}`,
      done: uploadState !== "idle" && uploadState !== "reading" && uploadState !== "uploading",
      active: uploadState === "uploading",
    },
    {
      label: "Marking image for test",
      done: uploadState === "resetting" || uploadState === "confirming",
      active: uploadState === "testing",
    },
    {
      label: "Resetting device",
      done: false,
      active: uploadState === "resetting",
    },
  ];

  // File selection UI (not flashing)
  if (!isFlashing) {
    return (
      <div className="flex flex-col gap-4 p-4 h-full">
        <SecondaryButton onClick={handleBack}>
          <span className="flex items-center gap-1.5">
            <ArrowLeft className={iconMd} />
            Back
          </span>
        </SecondaryButton>

        {/* Selected file display */}
        {selectedFileName ? (
          <div className="flex items-center gap-3 p-3 rounded-lg border border-[color:var(--border-default)] bg-[var(--bg-surface)]">
            <Upload className={`${iconMd} text-amber-400 shrink-0`} />
            <div className="flex-1 min-w-0">
              <div className={`text-sm font-medium ${textPrimary} truncate`}>{selectedFileName}</div>
              {selectedFileSize !== null && (
                <div className={`text-xs ${textSecondary}`}>{formatKB(selectedFileSize)} KB</div>
              )}
            </div>
            <SecondaryButton onClick={handleBrowse}>
              <span className="flex items-center gap-1.5">
                <FolderOpen className={iconMd} />
                Browse
              </span>
            </SecondaryButton>
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center py-8 gap-3">
            <div className={`text-sm ${textSecondary}`}>No firmware file selected</div>
            <PrimaryButton onClick={handleBrowse}>
              <span className="flex items-center gap-1.5">
                <FolderOpen className={iconMd} />
                Browse
              </span>
            </PrimaryButton>
          </div>
        )}

        {/* Error */}
        {error && (
          <div className="p-3 text-sm text-red-600 bg-red-50 rounded-lg border border-red-200">
            {error}
          </div>
        )}

        {/* Flash button */}
        <div className="mt-auto pt-4">
          <PrimaryButton
            onClick={handleFlash}
            disabled={!selectedFilePath}
            className="w-full"
          >
            <span className="flex items-center justify-center gap-1.5">
              <Upload className={iconMd} />
              Flash
            </span>
          </PrimaryButton>
        </div>
      </div>
    );
  }

  // Flashing progress UI
  return (
    <div className="flex flex-col items-center gap-6 p-8 h-full">
      {/* Spinner */}
      <Loader2 className="w-12 h-12 text-amber-500 animate-spin" />

      {/* Progress steps */}
      <div className="flex flex-col gap-2 w-full max-w-sm">
        {steps.map((step, i) => (
          <div key={i}>
            <div className={`flex items-center gap-2 text-sm ${textPrimary}`}>
              {step.done ? (
                <Check className={`${iconMd} text-green-500 shrink-0`} />
              ) : step.active ? (
                <Loader2 className={`${iconMd} text-amber-500 animate-spin shrink-0`} />
              ) : (
                <div className="w-4 h-4 rounded-full border border-[color:var(--border-default)] shrink-0" />
              )}
              <span className={step.done ? "" : step.active ? "font-medium" : textSecondary}>
                {step.label}
              </span>
            </div>

            {/* Progress bar for upload step */}
            {i === 1 && step.active && uploadProgress && (
              <div className="ml-6 mt-1.5 space-y-1">
                <div className="h-2 rounded-full bg-[var(--bg-tertiary)] overflow-hidden">
                  <div
                    className="h-full rounded-full bg-[var(--accent-primary)]"
                    style={{ width: `${Math.round(uploadProgress.percent)}%` }}
                  />
                </div>
                <div className={`text-xs ${textSecondary}`}>
                  {formatKB(uploadProgress.bytes_sent)} / {formatKB(uploadProgress.total_bytes)} KB
                </div>
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Error */}
      {error && (
        <div className="p-3 text-sm text-red-600 bg-red-50 rounded-lg border border-red-200 w-full max-w-sm">
          {error}
        </div>
      )}

      {/* Cancel button — visible during upload only */}
      {uploadState === "uploading" && (
        <DangerButton onClick={handleCancel}>Cancel</DangerButton>
      )}
    </div>
  );
}
