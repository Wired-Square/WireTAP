// ui/src/apps/devices/components/InspectView.tsx
//
// Firmware image slot inspection. Adapted from upgrade/components/InspectView
// to work within the unified Devices wizard.

import { useState, useCallback } from "react";
import { RefreshCw, Upload, ArrowLeft, Copy, Check as CheckIcon } from "lucide-react";
import { textPrimary, textSecondary } from "../../../styles";
import { iconMd } from "../../../styles/spacing";
import { cardDefault } from "../../../styles/cardStyles";
import { PrimaryButton, SecondaryButton } from "../../../components/forms";
import { useUpgradeStore } from "../../upgrade/stores/upgradeStore";
import { useDevicesStore } from "../stores/devicesStore";
import { useProvisioningStore } from "../../provisioning/stores/provisioningStore";
import { smpListImages, smpDisconnect } from "../../../api/smpUpgrade";
import { pickFileToOpen } from "../../../api/dialogs";

function SlotBadge({ label, active }: { label: string; active: boolean }) {
  return (
    <span
      className={`text-xs px-1.5 py-0.5 rounded font-medium min-w-[72px] text-center inline-block ${
        active
          ? "bg-green-100 text-green-700"
          : "bg-[var(--bg-tertiary)] text-[color:var(--text-secondary)]"
      }`}
    >
      {label}
    </span>
  );
}

export default function InspectView() {
  const images = useUpgradeStore((s) => s.data.images);
  const selectedFileName = useUpgradeStore((s) => s.data.selectedFileName);
  const selectedFileSize = useUpgradeStore((s) => s.data.selectedFileSize);
  const upgradeError = useUpgradeStore((s) => s.ui.error);

  const setImages = useUpgradeStore((s) => s.setImages);
  const setSelectedFile = useUpgradeStore((s) => s.setSelectedFile);
  const setUpgradeError = useUpgradeStore((s) => s.setError);

  const setStep = useDevicesStore((s) => s.setStep);
  const setConnectionState = useDevicesStore((s) => s.setConnectionState);

  const [refreshing, setRefreshing] = useState(false);
  const [copiedHash, setCopiedHash] = useState<string | null>(null);

  const error = upgradeError || useDevicesStore((s) => s.ui.error);

  const handleCopyHash = useCallback(async (hash: string) => {
    try {
      await navigator.clipboard.writeText(hash);
      setCopiedHash(hash);
      setTimeout(() => setCopiedHash(null), 2000);
    } catch {
      // Fallback — ignore
    }
  }, []);

  const handleRefresh = async () => {
    setRefreshing(true);
    setUpgradeError(null);
    try {
      const imgs = await smpListImages();
      setImages(imgs);
    } catch (e) {
      setUpgradeError(String(e));
    } finally {
      setRefreshing(false);
    }
  };

  const handleSelectFirmware = async () => {
    try {
      const result = await pickFileToOpen({
        filters: [{ name: "Firmware", extensions: ["bin"] }],
      });
      if (result) {
        const fileName = result.split("/").pop() ?? result.split("\\").pop() ?? result;
        setSelectedFile(result, fileName, null);
        setStep("upload");
      }
    } catch (e) {
      setUpgradeError(String(e));
    }
  };

  const handleDisconnect = async () => {
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

  return (
    <div className="flex flex-col gap-4 p-4 h-full">
      {/* Header */}
      <div className="flex items-center justify-between">
        <SecondaryButton onClick={handleDisconnect}>
          <span className="flex items-center gap-1.5">
            <ArrowLeft className={iconMd} />
            Disconnect
          </span>
        </SecondaryButton>
        <SecondaryButton onClick={handleRefresh} disabled={refreshing}>
          <span className="flex items-center gap-1.5">
            <RefreshCw className={`${iconMd} ${refreshing ? "animate-spin" : ""}`} />
            Refresh
          </span>
        </SecondaryButton>
      </div>

      {/* Error */}
      {error && (
        <div className="p-3 text-sm text-red-600 bg-red-50 rounded-lg border border-red-200">
          {error}
        </div>
      )}

      {/* Image slots */}
      {images.length === 0 ? (
        <div className={`text-sm ${textSecondary} text-center py-8`}>
          No image slot information available
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {images.map((img, idx) => (
            <div key={idx} className={`${cardDefault} p-3`}>
              <div className="flex items-center justify-between mb-2">
                <span className={`text-sm font-medium ${textPrimary}`}>
                  Slot {img.slot}{img.image !== null ? ` (Image ${img.image})` : ""}
                </span>
                <div className="flex gap-1">
                  {img.active && <SlotBadge label="Active" active />}
                  {img.confirmed && <SlotBadge label="Confirmed" active={false} />}
                  {img.pending && <SlotBadge label="Pending" active={false} />}
                  {img.bootable && <SlotBadge label="Bootable" active={false} />}
                  {img.permanent && <SlotBadge label="Permanent" active={false} />}
                </div>
              </div>
              <div className={`text-xs ${textSecondary} space-y-0.5`}>
                <div>
                  Version:{" "}
                  <span className={`font-mono ${textPrimary}`}>{img.version || "—"}</span>
                </div>
                <div className="font-mono flex items-center gap-1.5">
                  <span className="font-sans">Hash:</span>{" "}
                  {img.hash ? (
                    <>
                      <button
                        onClick={() => handleCopyHash(img.hash)}
                        className={`${textPrimary} cursor-pointer hover:underline text-left break-all`}
                        title="Click to copy hash"
                      >
                        {img.hash}
                      </button>
                      <button
                        onClick={() => handleCopyHash(img.hash)}
                        className="shrink-0 cursor-pointer text-[color:var(--text-secondary)] hover:text-[color:var(--text-primary)] transition-colors"
                        title="Copy hash"
                      >
                        {copiedHash === img.hash ? (
                          <CheckIcon className="w-3.5 h-3.5 text-green-500" />
                        ) : (
                          <Copy className="w-3.5 h-3.5" />
                        )}
                      </button>
                    </>
                  ) : (
                    <span>—</span>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Selected file indicator */}
      {selectedFileName && (
        <div className={`text-xs ${textSecondary}`}>
          Selected: <span className={textPrimary}>{selectedFileName}</span>
          {selectedFileSize !== null && ` (${(selectedFileSize / 1024).toFixed(1)} KB)`}
        </div>
      )}

      {/* Select firmware button */}
      <div className="mt-auto pt-4 flex justify-end">
        <PrimaryButton onClick={handleSelectFirmware} className="min-w-[10rem]">
          <span className="flex items-center justify-center gap-1.5">
            <Upload className={iconMd} />
            Select Firmware
          </span>
        </PrimaryButton>
      </div>
    </div>
  );
}
