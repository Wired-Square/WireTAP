// ui/src/apps/serial/views/DfuFlashView.tsx
//
// STM32 DFU flasher — wraps the DFU 1.1 / DfuSe protocol via the
// `dfu-nusb` + `dfu-core` Rust crates. Independent of the serial port:
// the µC must already be in DFU mode (BOOT0 high, reset).

import { useCallback, useEffect, useMemo, useState } from "react";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { listen } from "@tauri-apps/api/event";
import { FileUp, Play, RefreshCcw, Usb, X } from "lucide-react";
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
  flasherDfuListDevices,
} from "../../../api/flashers";
import { tlog } from "../../../api/settings";
import { useSerialStore } from "../stores/serialStore";
import type {
  DfuDeviceInfo,
  FlasherProgressEvent,
} from "../utils/flasherTypes";

export default function DfuFlashView() {
  const dfuFlash = useSerialStore((s) => s.dfuFlash);
  const setDfuFlash = useSerialStore((s) => s.setDfuFlash);
  const appendLog = useSerialStore((s) => s.appendDfuLog);
  const reset = useSerialStore((s) => s.resetDfuFlash);

  const [devices, setDevices] = useState<DfuDeviceInfo[]>([]);
  const [scanning, setScanning] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [imagePath, setImagePath] = useState<string | null>(null);
  const [address, setAddress] = useState("0x08000000");
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    setScanning(true);
    try {
      const list = await flasherDfuListDevices();
      setDevices(list);
      if (!selected && list.length > 0) setSelected(list[0].serial);
    } catch (err) {
      tlog.info(`[Serial/DFU] list failed: ${err}`);
    } finally {
      setScanning(false);
    }
  }, [selected]);

  useEffect(() => {
    refresh();
  }, [refresh]);

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
    if (!selected || !imagePath) return;
    const addr = parseInt(address, address.startsWith("0x") ? 16 : 10);
    if (Number.isNaN(addr)) {
      appendLog(`Invalid address: ${address}`);
      return;
    }
    setBusy(true);
    reset();
    try {
      const flashId = await flasherDfuFlash(selected, imagePath, addr);
      setDfuFlash({ flashId, phase: "connecting" });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      tlog.info(`[Serial/DFU] flash failed: ${msg}`);
      appendLog(`Flash failed: ${msg}`);
      setDfuFlash({ phase: "error", error: msg });
    } finally {
      setBusy(false);
    }
  }, [selected, imagePath, address, reset, setDfuFlash, appendLog]);

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
      <div
        className={`flex items-center justify-between px-3 py-2 ${borderDivider} border-b`}
      >
        <span className={`text-xs font-medium ${textSecondary}`}>
          DFU devices ({devices.length})
        </span>
        <button
          onClick={refresh}
          disabled={scanning}
          className={`flex items-center gap-1 text-xs px-2 py-1 rounded hover:bg-[var(--hover-bg)] ${textSecondary}`}
        >
          <RefreshCcw size={12} className={scanning ? "animate-spin" : ""} />
          Rescan
        </button>
      </div>

      <ul className="max-h-40 overflow-y-auto">
        {devices.length === 0 && !scanning && (
          <li className={`p-3 text-xs ${textMuted}`}>
            No DFU devices detected. Hold BOOT0 high and reset the µC.
          </li>
        )}
        {devices.map((d) => (
          <li key={d.serial}>
            <button
              onClick={() => setSelected(d.serial)}
              className={`w-full flex items-center gap-2 px-3 py-2 text-left text-xs border-b ${borderDivider} ${
                selected === d.serial ? "bg-sky-500/10" : "hover:bg-[var(--hover-bg)]"
              }`}
            >
              <Usb size={14} className={textMuted} />
              <div className="flex-1 min-w-0">
                <div className={`font-mono ${textPrimary} truncate`}>
                  {d.display_name}
                </div>
                <div className={`${textMuted} truncate`}>
                  {hexId(d.vid)}:{hexId(d.pid)} · {d.serial}
                </div>
              </div>
            </button>
          </li>
        ))}
      </ul>

      <div className={`p-3 ${bgSurface} ${borderDivider} border-y flex flex-wrap gap-3 items-end`}>
        <div className="flex flex-col gap-1">
          <span className="text-[10px] uppercase tracking-wide text-[color:var(--text-muted)]">
            Image
          </span>
          <button
            onClick={pickFile}
            className={`flex items-center gap-1 text-xs px-2 py-1 rounded ${bgPrimary} ${textPrimary} border ${borderDivider} hover:bg-[var(--hover-bg)]`}
          >
            <FileUp size={12} />
            {imagePath ?? "Choose .bin / .dfu / .hex"}
          </button>
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-[10px] uppercase tracking-wide text-[color:var(--text-muted)]">
            Flash address
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
              Cancel
            </button>
          ) : (
            <button
              onClick={flash}
              disabled={!selected || !imagePath || busy}
              className="flex items-center gap-1 text-xs px-3 py-1.5 rounded bg-sky-500/20 text-sky-300 hover:bg-sky-500/30 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <Play size={12} />
              Flash
            </button>
          )}
        </div>
      </div>

      {(inProgress || dfuFlash.phase === "done" || dfuFlash.phase === "error") && (
        <div className={`px-3 py-2 ${borderDivider} border-b`}>
          <div className={`text-xs ${textSecondary} mb-1 capitalize`}>
            {dfuFlash.phase} — {progressPct}% ({dfuFlash.bytesDone}/{dfuFlash.bytesTotal} bytes)
          </div>
          <div className="h-2 rounded bg-[var(--bg-primary)] overflow-hidden">
            <div
              className="h-full bg-sky-400 transition-all"
              style={{ width: `${progressPct}%` }}
            />
          </div>
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
            Boot the µC into DFU mode, pick an image, and click Flash.
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
