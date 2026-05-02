// ui/src/apps/serial/views/EspFlashView.tsx
//
// ESP32-family flasher — wraps Espressif's esptool protocol via the `espflash`
// Rust crate. Takes the port exclusively for the duration of a flash, so the
// terminal session is torn down before flashing and may be reconnected after.

import { useCallback, useEffect, useMemo, useState } from "react";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { listen } from "@tauri-apps/api/event";
import { Cpu, FileUp, Play, X } from "lucide-react";
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
  flasherEspCancel,
  flasherEspDetectChip,
  flasherEspFlash,
} from "../../../api/flashers";
import { tlog } from "../../../api/settings";
import { useSerialStore } from "../stores/serialStore";
import type {
  EspChipInfo,
  FlasherProgressEvent,
} from "../utils/flasherTypes";

interface Props {
  /** Disconnect the terminal session before starting a flash. */
  onBeforeFlash: () => Promise<void>;
}

export default function EspFlashView({ onBeforeFlash }: Props) {
  const settings = useSerialStore((s) => s.settings);
  const espFlash = useSerialStore((s) => s.espFlash);
  const setEspFlash = useSerialStore((s) => s.setEspFlash);
  const appendLog = useSerialStore((s) => s.appendEspLog);
  const reset = useSerialStore((s) => s.resetEspFlash);

  const [imagePath, setImagePath] = useState<string | null>(null);
  const [address, setAddress] = useState("0x10000");
  const [chip, setChip] = useState<EspChipInfo | null>(null);
  const [busy, setBusy] = useState(false);

  // Subscribe to flasher progress events for our flash id only.
  useEffect(() => {
    const id = espFlash.flashId;
    if (!id) return;
    const unlistenPromise = listen<FlasherProgressEvent>(
      FLASHER_PROGRESS_EVENT,
      (event) => {
        const p = event.payload;
        if (p.flash_id !== id) return;
        setEspFlash({
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
  }, [espFlash.flashId, setEspFlash, appendLog]);

  const pickFile = useCallback(async () => {
    const selected = await openFileDialog({
      multiple: false,
      filters: [{ name: "Firmware", extensions: ["bin", "elf"] }],
    });
    if (typeof selected === "string") setImagePath(selected);
  }, []);

  const detect = useCallback(async () => {
    if (!settings.port) return;
    setBusy(true);
    try {
      await onBeforeFlash();
      const info = await flasherEspDetectChip(settings.port, settings.baudRate);
      setChip(info);
      appendLog(`Detected ${info.chip} (${info.mac})`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      tlog.info(`[Serial/ESP] detect failed: ${msg}`);
      appendLog(`Detect failed: ${msg}`);
    } finally {
      setBusy(false);
    }
  }, [settings.port, settings.baudRate, onBeforeFlash, appendLog]);

  const flash = useCallback(async () => {
    if (!settings.port || !imagePath) return;
    const addr = parseInt(address, address.startsWith("0x") ? 16 : 10);
    if (Number.isNaN(addr)) {
      appendLog(`Invalid address: ${address}`);
      return;
    }
    setBusy(true);
    reset();
    try {
      await onBeforeFlash();
      const flashId = await flasherEspFlash(
        settings.port,
        settings.baudRate,
        imagePath,
        addr,
      );
      setEspFlash({ flashId, phase: "connecting" });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      tlog.info(`[Serial/ESP] flash failed: ${msg}`);
      appendLog(`Flash failed: ${msg}`);
      setEspFlash({ phase: "error", error: msg });
    } finally {
      setBusy(false);
    }
  }, [settings.port, settings.baudRate, imagePath, address, onBeforeFlash, reset, setEspFlash, appendLog]);

  const cancel = useCallback(async () => {
    if (!espFlash.flashId) return;
    try {
      await flasherEspCancel(espFlash.flashId);
    } catch (err) {
      tlog.info(`[Serial/ESP] cancel failed: ${err}`);
    }
  }, [espFlash.flashId]);

  const progressPct = useMemo(() => {
    if (!espFlash.bytesTotal) return 0;
    return Math.min(100, Math.round((espFlash.bytesDone / espFlash.bytesTotal) * 100));
  }, [espFlash.bytesDone, espFlash.bytesTotal]);

  const inProgress =
    espFlash.phase !== "idle" &&
    espFlash.phase !== "done" &&
    espFlash.phase !== "error" &&
    espFlash.phase !== "cancelled";

  return (
    <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
      <div className={`p-3 ${bgSurface} ${borderDivider} border-b flex flex-wrap gap-3 items-end`}>
        <div className="flex flex-col gap-1">
          <span className="text-[10px] uppercase tracking-wide text-[color:var(--text-muted)]">
            Image
          </span>
          <button
            onClick={pickFile}
            className={`flex items-center gap-1 text-xs px-2 py-1 rounded ${bgPrimary} ${textPrimary} border ${borderDivider} hover:bg-[var(--hover-bg)]`}
          >
            <FileUp size={12} />
            {imagePath ?? "Choose .bin / .elf"}
          </button>
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-[10px] uppercase tracking-wide text-[color:var(--text-muted)]">
            Flash address
          </span>
          <input
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            className={`${bgPrimary} ${textPrimary} text-xs px-2 py-1 rounded border ${borderDivider} font-mono w-28`}
          />
        </div>
        <div className="ml-auto flex items-center gap-2">
          <button
            onClick={detect}
            disabled={!settings.port || busy || inProgress}
            className="flex items-center gap-1 text-xs px-3 py-1.5 rounded bg-violet-500/20 text-violet-300 hover:bg-violet-500/30 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <Cpu size={12} />
            Detect chip
          </button>
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
              disabled={!settings.port || !imagePath || busy}
              className="flex items-center gap-1 text-xs px-3 py-1.5 rounded bg-sky-500/20 text-sky-300 hover:bg-sky-500/30 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <Play size={12} />
              Flash
            </button>
          )}
        </div>
      </div>

      {chip && (
        <div className={`px-3 py-2 text-xs ${textSecondary} ${borderDivider} border-b`}>
          <span className="font-medium">{chip.chip}</span>
          {chip.flash_size_bytes ? (
            <> — {(chip.flash_size_bytes / 1024 / 1024).toFixed(0)} MB flash</>
          ) : null}{" "}
          — MAC <span className="font-mono">{chip.mac}</span>
        </div>
      )}

      {(inProgress || espFlash.phase === "done" || espFlash.phase === "error") && (
        <div className={`px-3 py-2 ${borderDivider} border-b`}>
          <div className={`text-xs ${textSecondary} mb-1 capitalize`}>
            {espFlash.phase} — {progressPct}% ({espFlash.bytesDone}/{espFlash.bytesTotal} bytes)
          </div>
          <div className="h-2 rounded bg-[var(--bg-primary)] overflow-hidden">
            <div
              className="h-full bg-sky-400 transition-all"
              style={{ width: `${progressPct}%` }}
            />
          </div>
          {espFlash.error && (
            <div className="text-xs text-[color:var(--text-danger)] mt-1">
              {espFlash.error}
            </div>
          )}
        </div>
      )}

      <div className="flex-1 overflow-y-auto p-3 font-mono text-xs">
        {espFlash.log.length === 0 ? (
          <div className={textMuted}>
            Pick an image and click Flash to begin. The terminal will be
            disconnected for the duration of the flash.
          </div>
        ) : (
          espFlash.log.map((line, i) => (
            <div key={i} className={textPrimary}>
              {line}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
