// ui/src/apps/serial/views/DfuFlashView.tsx
//
// STM32 DFU flasher — wraps the DFU 1.1 / DfuSe protocol via the
// `dfu-nusb` + `dfu-core` Rust crates. Independent of the serial port:
// the µC must already be in DFU mode (BOOT0 high, reset).
//
// Device selection lives in the shared SerialPortPicker (top nav). This
// view just reads the selected DFU serial from the store and exposes the
// firmware-image controls + progress UI.

import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { listen } from "@tauri-apps/api/event";
import { FileUp, Play, ShieldAlert, Usb, X } from "lucide-react";
import {
  bgPrimary,
  bgSurface,
  borderDivider,
  textPrimary,
  textSecondary,
  textMuted,
} from "../../../styles/colourTokens";
import {
  FLASHER_PROGRESS_EVENT,
  flasherDfuCancel,
  flasherDfuFlash,
} from "../../../api/flashers";
import { tlog } from "../../../api/settings";
import { useSerialStore } from "../stores/serialStore";
import type { FlasherProgressEvent } from "../utils/flasherTypes";

export default function DfuFlashView() {
  const { t } = useTranslation("serial");
  const dfuFlash = useSerialStore((s) => s.dfuFlash);
  const setDfuFlash = useSerialStore((s) => s.setDfuFlash);
  const appendLog = useSerialStore((s) => s.appendDfuLog);
  const reset = useSerialStore((s) => s.resetDfuFlash);
  const dfuDevices = useSerialStore((s) => s.dfuDevices);
  const dfuSerial = useSerialStore((s) => s.dfuSerial);

  const [imagePath, setImagePath] = useState<string | null>(null);
  const [address, setAddress] = useState("0x08000000");
  const [busy, setBusy] = useState(false);

  const selectedDevice = useMemo(
    () => dfuDevices.find((d) => d.serial === dfuSerial) ?? null,
    [dfuDevices, dfuSerial],
  );

  // Subscribe to flasher progress events for our flash id only.
  useEffect(() => {
    const id = dfuFlash.flashId;
    if (!id) return;
    const unlistenPromise = listen<FlasherProgressEvent>(
      FLASHER_PROGRESS_EVENT,
      (event) => {
        const p = event.payload;
        if (p.flash_id !== id) return;
        setDfuFlash({
          phase: p.phase,
          bytesDone: p.bytes_done,
          bytesTotal: p.bytes_total,
          error: p.phase === "error" ? p.message ?? "Flash failed" : null,
        });
        if (p.message) appendLog(`[${p.phase}] ${p.message}`);
      },
    );
    return () => {
      unlistenPromise.then((fn) => fn()).catch(() => {});
    };
  }, [dfuFlash.flashId, setDfuFlash, appendLog]);

  const pickFile = useCallback(async () => {
    const picked = await openFileDialog({
      multiple: false,
      filters: [{ name: "Firmware", extensions: ["bin", "dfu", "hex"] }],
    });
    if (typeof picked === "string") setImagePath(picked);
  }, []);

  const flash = useCallback(async () => {
    if (!dfuSerial || !imagePath) return;
    const addr = parseInt(address, address.startsWith("0x") ? 16 : 10);
    if (Number.isNaN(addr)) {
      appendLog(t("dfu.invalidAddress", { address }));
      return;
    }
    setBusy(true);
    reset();
    try {
      const flashId = await flasherDfuFlash(dfuSerial, imagePath, addr);
      setDfuFlash({ flashId, phase: "connecting" });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      tlog.info(`[Serial/DFU] flash failed: ${msg}`);
      appendLog(t("dfu.flashFailed", { error: msg }));
      setDfuFlash({ phase: "error", error: msg });
    } finally {
      setBusy(false);
    }
  }, [dfuSerial, imagePath, address, reset, setDfuFlash, appendLog, t]);

  const cancel = useCallback(async () => {
    if (!dfuFlash.flashId) return;
    try {
      await flasherDfuCancel(dfuFlash.flashId);
    } catch (err) {
      tlog.info(`[Serial/DFU] cancel failed: ${err}`);
    }
  }, [dfuFlash.flashId]);

  const progressPct = useMemo(() => {
    if (!dfuFlash.bytesTotal) return 0;
    return Math.min(100, Math.round((dfuFlash.bytesDone / dfuFlash.bytesTotal) * 100));
  }, [dfuFlash.bytesDone, dfuFlash.bytesTotal]);

  const inProgress =
    dfuFlash.phase !== "idle" &&
    dfuFlash.phase !== "done" &&
    dfuFlash.phase !== "error" &&
    dfuFlash.phase !== "cancelled";

  return (
    <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
      {/* Selected device status bar — picker lives in the top nav. */}
      <div
        className={`flex items-center gap-3 px-3 py-2 ${borderDivider} border-b text-xs ${textSecondary}`}
      >
        <Usb size={14} className="text-amber-300" />
        {selectedDevice ? (
          <>
            <span className={`font-medium ${textPrimary}`}>
              {selectedDevice.display_name}
            </span>
            <span className="font-mono">
              · {hexId(selectedDevice.vid)}:{hexId(selectedDevice.pid)}
            </span>
            <span className={`font-mono truncate ${textMuted}`}>
              · {selectedDevice.serial}
            </span>
          </>
        ) : (
          <div className="flex items-center gap-2">
            <ShieldAlert size={12} className="text-amber-300" />
            <span className={textMuted}>{t("dfu.noDeviceSelected")}</span>
          </div>
        )}
      </div>

      {/* Image + address controls */}
      <div className={`p-3 ${bgSurface} ${borderDivider} border-b flex flex-wrap gap-3 items-end`}>
        <div className="flex flex-col gap-1">
          <span className="text-[10px] uppercase tracking-wide text-[color:var(--text-muted)]">
            {t("dfu.fields.image")}
          </span>
          <button
            onClick={pickFile}
            className={`flex items-center gap-1 text-xs px-2 py-1 rounded ${bgPrimary} ${textPrimary} border ${borderDivider} hover:bg-[var(--hover-bg)]`}
          >
            <FileUp size={12} />
            {imagePath ?? t("dfu.fields.imageEmpty")}
          </button>
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-[10px] uppercase tracking-wide text-[color:var(--text-muted)]">
            {t("dfu.fields.address")}
          </span>
          <input
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            className={`${bgPrimary} ${textPrimary} text-xs px-2 py-1 rounded border ${borderDivider} font-mono w-32`}
          />
        </div>
        <div className="ml-auto flex items-center gap-2">
          {inProgress ? (
            <button
              onClick={cancel}
              className="flex items-center gap-1 text-xs px-3 py-1.5 rounded bg-red-500/20 text-red-300 hover:bg-red-500/30"
            >
              <X size={12} />
              {t("dfu.cancel")}
            </button>
          ) : (
            <button
              onClick={flash}
              disabled={!dfuSerial || !imagePath || busy}
              className="flex items-center gap-1 text-xs px-3 py-1.5 rounded bg-amber-500/20 text-amber-300 hover:bg-amber-500/30 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <Play size={12} />
              {t("dfu.flash")}
            </button>
          )}
        </div>
      </div>

      {(inProgress || dfuFlash.phase === "done" || dfuFlash.phase === "error" || dfuFlash.phase === "cancelled") && (
        <div className={`px-3 py-2 ${borderDivider} border-b`}>
          <div className={`text-xs ${textSecondary} mb-1 capitalize`}>
            {dfuFlash.phase}
            {dfuFlash.bytesTotal > 0 && (
              <>
                {" "}— {progressPct}% (
                {dfuFlash.bytesDone.toLocaleString("en-AU")}/
                {dfuFlash.bytesTotal.toLocaleString("en-AU")} {t("dfu.bytes")})
              </>
            )}
          </div>
          {dfuFlash.bytesTotal > 0 && (
            <div className="h-2 rounded bg-[var(--bg-primary)] overflow-hidden">
              <div
                className="h-full bg-amber-400 transition-all"
                style={{ width: `${progressPct}%` }}
              />
            </div>
          )}
          {dfuFlash.error && (
            <div className="text-xs text-[color:var(--text-danger)] mt-1">
              {dfuFlash.error}
            </div>
          )}
        </div>
      )}

      <div className="flex-1 overflow-y-auto p-3 font-mono text-xs">
        {dfuFlash.log.length === 0 ? (
          <div className={textMuted}>
            {selectedDevice
              ? t("dfu.emptyStateReady")
              : t("dfu.emptyStateNoDevice")}
          </div>
        ) : (
          dfuFlash.log.map((line, i) => (
            <div key={i} className={textPrimary}>
              {line}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function hexId(n: number): string {
  return `0x${n.toString(16).padStart(4, "0")}`;
}
