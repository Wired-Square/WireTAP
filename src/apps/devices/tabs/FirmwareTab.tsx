// ui/src/apps/devices/tabs/FirmwareTab.tsx
//
// Firmware upgrade tab — works for either BLE-attached SMP or IP/UDP SMP. The
// transport prop selects which ensureXxx() to call on activation; the rest
// of the flow (image inspection → file pick → upload progress → reboot →
// reconnect+confirm) is identical.

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ArrowLeft,
  Check,
  Check as CheckIcon,
  CheckCircle,
  Copy,
  FolderOpen,
  Loader2,
  RefreshCw,
  Upload,
  XCircle,
} from "lucide-react";
import {
  alertDanger,
  alertSuccess,
  iconMd,
  textDanger,
  textPrimary,
  textSecondary,
} from "../../../styles";
import { cardDefault } from "../../../styles/cardStyles";
import {
  DangerButton,
  PrimaryButton,
  SecondaryButton,
} from "../../../components/forms";
import { useDevicesStore } from "../stores/devicesStore";
import { useUpgradeStore } from "../../upgrade/stores/upgradeStore";
import { useDeviceConnection } from "../hooks/useDeviceConnection";
import {
  smpCancelUpload,
  smpConfirmImage,
  smpConnectUdp,
  smpListImages,
  smpReconnectBleByName,
  smpResetDevice,
  smpTestImage,
  smpUploadFirmware,
} from "../../../api/smpUpgrade";
import { pickFileToOpen } from "../../../api/dialogs";

type FirmwarePhase = "inspect" | "upload" | "flashing" | "result";

export type FirmwareTransport = "ble" | "ip";

interface FirmwareTabProps {
  transport: FirmwareTransport;
}

function formatKB(bytes: number): string {
  return (bytes / 1024).toFixed(1);
}

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

export default function FirmwareTab({ transport }: FirmwareTabProps) {
  const { t } = useTranslation("devices");
  const images = useUpgradeStore((s) => s.data.images);
  const selectedFilePath = useUpgradeStore((s) => s.data.selectedFilePath);
  const selectedFileName = useUpgradeStore((s) => s.data.selectedFileName);
  const selectedFileSize = useUpgradeStore((s) => s.data.selectedFileSize);
  const uploadProgress = useUpgradeStore((s) => s.data.uploadProgress);
  const uploadState = useUpgradeStore((s) => s.ui.uploadState);
  const upgradeError = useUpgradeStore((s) => s.ui.error);

  const setImages = useUpgradeStore((s) => s.setImages);
  const setSelectedFile = useUpgradeStore((s) => s.setSelectedFile);
  const setUploadProgress = useUpgradeStore((s) => s.setUploadProgress);
  const setUploadState = useUpgradeStore((s) => s.setUploadState);
  const setUpgradeError = useUpgradeStore((s) => s.setError);
  const setStatusMessage = useUpgradeStore((s) => s.setStatusMessage);
  const setUpgradeConnectionState = useUpgradeStore((s) => s.setConnectionState);

  const transports = useDevicesStore((s) => s.ui.transports);
  const selectedAddress = useDevicesStore((s) => s.data.selectedAddress);
  const selectedSmpPort = useDevicesStore((s) => s.data.selectedSmpPort);

  const { ensureBleSmp, ensureIpSmp } = useDeviceConnection();

  const [phase, setPhase] = useState<FirmwarePhase>("inspect");
  const [refreshing, setRefreshing] = useState(false);
  const [copiedHash, setCopiedHash] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);
  const flashingRef = useRef(false);

  const transportReady =
    transport === "ble" ? transports.bleSmp : transports.ipSmp;

  // Bring up SMP on activation, then read image slots.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        if (transport === "ble") {
          await ensureBleSmp();
        } else {
          await ensureIpSmp();
        }
        if (cancelled) return;
        try {
          const imgs = await smpListImages();
          if (!cancelled) setImages(imgs);
        } catch {
          // Non-critical on first load
        }
      } catch (e) {
        if (!cancelled) setConnectError(String(e));
      }
    })();
    return () => { cancelled = true; };
  }, [transport, ensureBleSmp, ensureIpSmp, setImages]);

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
        setPhase("upload");
      }
    } catch (e) {
      setUpgradeError(String(e));
    }
  };

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
    setPhase("flashing");

    try {
      setUploadState("reading");
      setStatusMessage(t("upload.readingFirmware"));

      setUploadState("uploading");
      setStatusMessage(t("upload.uploadingFirmware"));
      await smpUploadFirmware(selectedFilePath);

      const { ui } = useUpgradeStore.getState();
      if (ui.uploadState === "error") return;

      setUploadState("testing");
      setStatusMessage(t("upload.markingTest"));

      const imgs = await smpListImages();
      const pendingImage = imgs.find((img) => img.slot === 1 && img.pending);
      if (pendingImage) {
        const hashBytes: number[] = [];
        for (let i = 0; i < pendingImage.hash.length; i += 2) {
          hashBytes.push(parseInt(pendingImage.hash.slice(i, i + 2), 16));
        }
        await smpTestImage(hashBytes);
      }

      setUploadState("resetting");
      setStatusMessage(t("upload.resetting"));
      await smpResetDevice();

      setPhase("result");
    } catch (e) {
      setUploadState("error");
      setUpgradeError(String(e));
      setStatusMessage(null);
      setPhase("result");
    } finally {
      flashingRef.current = false;
    }
  };

  const handleCancelFlash = async () => {
    try { await smpCancelUpload(); } catch { /* ignore */ }
    setUploadState("error");
    setUpgradeError(t("upload.uploadCancelled"));
    setStatusMessage(null);
    flashingRef.current = false;
  };

  const handleReconnectAndConfirm = async () => {
    setConfirming(true);
    setUpgradeError(null);

    try {
      // The device rebooted; the prior socket is stale. Re-establish.
      if (transport === "ip") {
        if (!selectedAddress || selectedSmpPort == null) {
          throw new Error(t("upgradeFlow.noUdpAddress"));
        }
        await smpConnectUdp(selectedAddress, selectedSmpPort);
      } else {
        // Firmware test-boot rotates the device's BLE peripheral
        // identifier, so the cached selectedBleId is stale. Reconnect by
        // name (firmware-stable) and let the backend poll Discovery for
        // the device's new BLE id.
        const name = useDevicesStore.getState().data.selectedDeviceName;
        if (!name) throw new Error("Device name missing for reconnect");
        await smpReconnectBleByName(name, 30);
      }
      setUpgradeConnectionState("connected");

      const imgs = await smpListImages();
      setImages(imgs);
      const activeImage = imgs.find((img) => img.active && !img.confirmed);
      if (activeImage) {
        const hashBytes: number[] = [];
        for (let i = 0; i < activeImage.hash.length; i += 2) {
          hashBytes.push(parseInt(activeImage.hash.slice(i, i + 2), 16));
        }
        await smpConfirmImage(hashBytes);
      }
      setUploadState("confirming");
    } catch (e) {
      setUpgradeError(String(e));
    } finally {
      setConfirming(false);
    }
  };

  const handleRetryFlash = () => {
    setUploadState("idle");
    setUpgradeError(null);
    setUploadProgress(null);
    setPhase("upload");
  };

  const handleBackToInspect = () => {
    setUploadState("idle");
    setUpgradeError(null);
    setUploadProgress(null);
    setPhase("inspect");
  };

  // ── Connection failure short-circuit ─────────────────────────────────────
  if (connectError && !transportReady) {
    return (
      <div className="p-4">
        <div className={`${alertDanger} ${textDanger} text-sm`}>{connectError}</div>
      </div>
    );
  }

  // ── Phase: flashing in progress ──────────────────────────────────────────
  if (phase === "flashing") {
    const steps = [
      {
        label: selectedFileSize !== null
          ? t("upload.steps.readingWithSize", { kb: formatKB(selectedFileSize) })
          : t("upload.steps.reading"),
        done: uploadState !== "idle" && uploadState !== "reading",
        active: uploadState === "reading",
      },
      {
        label: uploadProgress
          ? t("upload.steps.uploadingPercent", { percent: Math.round(uploadProgress.percent) })
          : t("upload.steps.uploading"),
        done: uploadState !== "idle" && uploadState !== "reading" && uploadState !== "uploading",
        active: uploadState === "uploading",
      },
      {
        label: t("upload.steps.marking"),
        done: uploadState === "resetting" || uploadState === "confirming",
        active: uploadState === "testing",
      },
      {
        label: t("upload.steps.resetting"),
        done: false,
        active: uploadState === "resetting",
      },
    ];

    return (
      <div className="flex flex-col items-center gap-6 p-8 h-full">
        <Loader2 className="w-12 h-12 text-amber-500 animate-spin" />
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
              {i === 1 && step.active && uploadProgress && (
                <div className="ml-6 mt-1.5 space-y-1">
                  <div className="h-2 rounded-full bg-[var(--bg-tertiary)] overflow-hidden">
                    <div
                      className="h-full rounded-full bg-[var(--accent-primary)]"
                      style={{ width: `${Math.round(uploadProgress.percent)}%` }}
                    />
                  </div>
                  <div className={`text-xs ${textSecondary}`}>
                    {t("upload.uploadProgress", {
                      sent: formatKB(uploadProgress.bytes_sent),
                      total: formatKB(uploadProgress.total_bytes),
                    })}
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
        {upgradeError && (
          <div className={`${alertDanger} ${textDanger} text-sm w-full max-w-sm`}>
            {upgradeError}
          </div>
        )}
        {uploadState === "uploading" && (
          <DangerButton onClick={handleCancelFlash}>{t("upload.cancel")}</DangerButton>
        )}
      </div>
    );
  }

  // ── Phase: post-flash result ────────────────────────────────────────────
  if (phase === "result") {
    const isSuccess = uploadState !== "error";
    if (!isSuccess) {
      return (
        <div className="flex flex-col items-center gap-6 p-8 h-full">
          <XCircle className="w-16 h-16 text-red-500" />
          <div className={`text-lg font-medium ${textPrimary}`}>
            {t("upgradeFlow.failedTitle")}
          </div>
          {upgradeError && (
            <div className={`${alertDanger} w-full max-w-sm text-sm`}>{upgradeError}</div>
          )}
          <PrimaryButton onClick={handleRetryFlash}>{t("upgradeFlow.retry")}</PrimaryButton>
        </div>
      );
    }
    return (
      <div className="flex flex-col items-center gap-6 p-8 h-full">
        <CheckCircle className="w-16 h-16 text-green-500" />
        <div className={`text-lg font-medium ${textPrimary}`}>{t("upgradeFlow.uploaded")}</div>
        <div className={`${alertSuccess} w-full max-w-sm text-sm`}>
          <div className="space-y-1">
            <div>
              <span className={textSecondary}>{t("upgradeFlow.statusLabel")}</span>{" "}
              <span className="font-medium">
                {uploadState === "confirming"
                  ? t("upgradeFlow.imageConfirmed")
                  : t("upgradeFlow.rebootingIntoNew")}
              </span>
            </div>
          </div>
        </div>
        {uploadState !== "confirming" && (
          <div className={`text-xs ${textSecondary} max-w-sm text-center`}>
            {t("upgradeFlow.rebootHint")}
          </div>
        )}
        {uploadState !== "confirming" && (
          <PrimaryButton onClick={handleReconnectAndConfirm} disabled={confirming}>
            <span className="flex items-center gap-1.5">
              <RefreshCw className={`${iconMd} ${confirming ? "animate-spin" : ""}`} />
              {confirming ? t("upgradeFlow.confirming") : t("upgradeFlow.reconnectConfirm")}
            </span>
          </PrimaryButton>
        )}
        {upgradeError && (
          <div className={`${alertDanger} ${textDanger} text-sm w-full max-w-sm`}>
            {upgradeError}
          </div>
        )}
      </div>
    );
  }

  // ── Phase: upload (file picked, ready to flash) ─────────────────────────
  if (phase === "upload") {
    return (
      <div className="flex flex-col gap-4 p-4 h-full">
        <SecondaryButton onClick={handleBackToInspect}>
          <span className="flex items-center gap-1.5">
            <ArrowLeft className={iconMd} />
            {t("upload.backToInspect")}
          </span>
        </SecondaryButton>

        {selectedFileName ? (
          <div className="flex items-center gap-3 p-3 rounded-lg border border-[color:var(--border-default)] bg-[var(--bg-surface)]">
            <Upload className={`${iconMd} text-amber-400 shrink-0`} />
            <div className="flex-1 min-w-0">
              <div className={`text-sm font-medium ${textPrimary} truncate`}>
                {selectedFileName}
              </div>
              {selectedFileSize !== null && (
                <div className={`text-xs ${textSecondary}`}>
                  {t("upload.kbSize", { kb: formatKB(selectedFileSize) })}
                </div>
              )}
            </div>
            <SecondaryButton onClick={handleBrowse}>
              <span className="flex items-center gap-1.5">
                <FolderOpen className={iconMd} />
                {t("upload.browse")}
              </span>
            </SecondaryButton>
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center py-8 gap-3">
            <div className={`text-sm ${textSecondary}`}>{t("upload.noFile")}</div>
            <PrimaryButton onClick={handleBrowse}>
              <span className="flex items-center gap-1.5">
                <FolderOpen className={iconMd} />
                {t("upload.browse")}
              </span>
            </PrimaryButton>
          </div>
        )}

        {upgradeError && (
          <div className={`p-3 text-sm ${textDanger} ${alertDanger}`}>{upgradeError}</div>
        )}

        <div className="mt-auto pt-4">
          <PrimaryButton
            onClick={handleFlash}
            disabled={!selectedFilePath || !transportReady}
            className="w-full"
          >
            <span className="flex items-center justify-center gap-1.5">
              <Upload className={iconMd} />
              {t("upload.flash")}
            </span>
          </PrimaryButton>
        </div>
      </div>
    );
  }

  // ── Phase: inspect (default) ─────────────────────────────────────────────
  return (
    <div className="flex flex-col gap-4 p-4 h-full">
      <div className="flex items-center justify-between">
        <div className={`text-sm font-medium ${textPrimary}`}>
          {t("inspect.title")}
        </div>
        <SecondaryButton onClick={handleRefresh} disabled={refreshing || !transportReady}>
          <span className="flex items-center gap-1.5">
            <RefreshCw className={`${iconMd} ${refreshing ? "animate-spin" : ""}`} />
            {t("inspect.refresh")}
          </span>
        </SecondaryButton>
      </div>

      {!transportReady && (
        <div className={`flex items-center gap-2 text-sm ${textSecondary}`}>
          <Loader2 className={`${iconMd} animate-spin`} />
          {transport === "ble" ? t("device.connectingBleSmp") : t("device.connectingIpSmp")}
        </div>
      )}

      {upgradeError && (
        <div className={`${alertDanger} ${textDanger} text-sm`}>{upgradeError}</div>
      )}

      {transportReady && images.length === 0 ? (
        <div className={`text-sm ${textSecondary} text-center py-8`}>{t("inspect.noSlots")}</div>
      ) : (
        <div className="flex flex-col gap-2">
          {images.map((img, idx) => (
            <div key={idx} className={`${cardDefault} p-3`}>
              <div className="flex items-center justify-between mb-2">
                <span className={`text-sm font-medium ${textPrimary}`}>
                  {img.image !== null
                    ? t("inspect.slotLabelWithImage", { slot: img.slot, image: img.image })
                    : t("inspect.slotLabel", { slot: img.slot })}
                </span>
                <div className="flex gap-1">
                  {img.active && <SlotBadge label={t("inspect.active")} active />}
                  {img.confirmed && <SlotBadge label={t("inspect.confirmed")} active={false} />}
                  {img.pending && <SlotBadge label={t("inspect.pending")} active={false} />}
                  {img.bootable && <SlotBadge label={t("inspect.bootable")} active={false} />}
                  {img.permanent && <SlotBadge label={t("inspect.permanent")} active={false} />}
                </div>
              </div>
              <div className={`text-xs ${textSecondary} space-y-0.5`}>
                <div>
                  {t("inspect.version")}{" "}
                  <span className={`font-mono ${textPrimary}`}>{img.version || "—"}</span>
                </div>
                <div className="font-mono flex items-center gap-1.5">
                  <span className="font-sans">{t("inspect.hash")}</span>{" "}
                  {img.hash ? (
                    <>
                      <button
                        onClick={() => handleCopyHash(img.hash)}
                        className={`${textPrimary} cursor-pointer hover:underline text-left break-all`}
                        title={t("inspect.copyHashTooltip")}
                      >
                        {img.hash}
                      </button>
                      <button
                        onClick={() => handleCopyHash(img.hash)}
                        className="shrink-0 cursor-pointer text-[color:var(--text-secondary)] hover:text-[color:var(--text-primary)] transition-colors"
                        title={t("inspect.copyHash")}
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

      {selectedFileName && (
        <div className={`text-xs ${textSecondary}`}>
          {t("inspect.selectedLabel")} <span className={textPrimary}>{selectedFileName}</span>
          {selectedFileSize !== null && ` ${t("inspect.selectedSize", { kb: (selectedFileSize / 1024).toFixed(1) })}`}
        </div>
      )}

      <div className="mt-auto pt-4 flex justify-end">
        <PrimaryButton
          onClick={handleSelectFirmware}
          disabled={!transportReady}
          className="min-w-[10rem]"
        >
          <span className="flex items-center justify-center gap-1.5">
            <Upload className={iconMd} />
            {t("inspect.selectFirmware")}
          </span>
        </PrimaryButton>
      </div>
    </div>
  );
}
