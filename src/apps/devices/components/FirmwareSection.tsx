// ui/src/apps/devices/components/FirmwareSection.tsx
//
// Inline firmware upgrade section rendered below WiFi provisioning fields.
// Auto-connects to the SMP service on the already-connected BLE peripheral
// (shares the same BLE connection — no disconnect needed), loads image slot
// data, and provides a "Select Firmware" button to start the upload flow.

import { useState, useEffect, useCallback } from "react";
import { RefreshCw, Upload, Copy, Check as CheckIcon } from "lucide-react";
import {
  textPrimary,
  textSecondary,
  textDanger,
  alertDanger,
  cardDefault,
  badgeSmallSuccess,
  badgeSmallNeutral,
  iconMd,
} from "../../../styles";
import { PrimaryButton, SecondaryButton } from "../../../components/forms";
import { useUpgradeStore } from "../../upgrade/stores/upgradeStore";
import { useDevicesStore } from "../stores/devicesStore";
import { smpAttachBle, smpListImages } from "../../../api/smpUpgrade";
import { pickFileToOpen } from "../../../api/dialogs";

function SlotBadge({ label, active }: { label: string; active: boolean }) {
  return (
    <span className={`min-w-[72px] text-center inline-block ${active ? badgeSmallSuccess : badgeSmallNeutral}`}>
      {label}
    </span>
  );
}

interface FirmwareSectionProps {
  deviceId: string;
  deviceName: string;
}

export default function FirmwareSection({ deviceId, deviceName }: FirmwareSectionProps) {
  const images = useUpgradeStore((s) => s.data.images);
  const setImages = useUpgradeStore((s) => s.setImages);
  const setSelectedFile = useUpgradeStore((s) => s.setSelectedFile);
  const setUpgradeSelectedDevice = useUpgradeStore((s) => s.setSelectedDevice);
  const setUpgradeConnectionState = useUpgradeStore((s) => s.setConnectionState);

  const setStep = useDevicesStore((s) => s.setStep);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [copiedHash, setCopiedHash] = useState<string | null>(null);

  // Attach to SMP service on the already-connected provisioning peripheral.
  // Uses smpAttachBle which reuses the existing BLE connection directly from
  // provisioning state — no adapter lookup, no scan, no radio-level reconnect.
  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        await smpAttachBle();
        if (cancelled) return;

        setUpgradeSelectedDevice(deviceId, deviceName, "ble");
        setUpgradeConnectionState("connected");

        try {
          const imgs = await smpListImages();
          if (!cancelled) setImages(imgs);
        } catch {
          // Non-critical — slots will show as empty
        }
      } catch (e) {
        if (!cancelled) setError(String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [deviceId]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleRefresh = async () => {
    setRefreshing(true);
    setError(null);
    try {
      const imgs = await smpListImages();
      setImages(imgs);
    } catch (e) {
      setError(String(e));
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
      setError(String(e));
    }
  };

  const handleCopyHash = useCallback(async (hash: string) => {
    try {
      await navigator.clipboard.writeText(hash);
      setCopiedHash(hash);
      setTimeout(() => setCopiedHash(null), 2000);
    } catch {
      // Fallback — ignore
    }
  }, []);

  return (
    <div className="mt-3 pt-5 border-t border-[color:var(--border-default)]">
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <div className={`text-sm font-medium ${textPrimary}`}>Firmware Upgrade</div>
        {!loading && images.length > 0 && (
          <SecondaryButton onClick={handleRefresh} disabled={refreshing} className="w-44">
            <span className="flex items-center gap-1.5">
              <RefreshCw className={`${iconMd} ${refreshing ? "animate-spin" : ""}`} />
              Refresh
            </span>
          </SecondaryButton>
        )}
      </div>

      {/* Error */}
      {error && (
        <div className={`${alertDanger} ${textDanger} text-sm mb-3`}>
          {error}
        </div>
      )}

      {/* Loading state */}
      {loading && (
        <div className="flex items-center justify-center py-6">
          <div className="w-5 h-5 border-2 border-sky-500 border-t-transparent rounded-full animate-spin" />
        </div>
      )}

      {/* Image slots */}
      {!loading && images.length === 0 && !error && (
        <div className={`text-sm ${textSecondary} text-center py-4`}>
          No image slot information available
        </div>
      )}

      {!loading && images.length > 0 && (
        <div className="flex flex-col gap-2 mb-3">
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
                  <span className={`font-mono ${textPrimary}`}>{img.version || "\u2014"}</span>
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
                    <span>{"\u2014"}</span>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Select firmware button */}
      {!loading && !error && (
        <div className="flex justify-end">
          <PrimaryButton onClick={handleSelectFirmware} className="min-w-[10rem]">
            <span className="flex items-center justify-center gap-1.5">
              <Upload className={iconMd} />
              Select Firmware
            </span>
          </PrimaryButton>
        </div>
      )}
    </div>
  );
}
