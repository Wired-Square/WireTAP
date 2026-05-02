// ui/src/apps/serial/views/Stm32FlashView.tsx
//
// STM32 UART flasher — drives ST's AN3155 system bootloader directly over
// the chosen serial port. Same three-mode shape as EspFlashView (write /
// backup / erase) plus auto-detect on tab entry. Bootloader entry is
// auto-pulsed on RTS/DTR with a configurable pin map; hardware that doesn't
// wire those lines can set both to "none" and put the chip in bootloader
// mode by hand before clicking Detect.
//
// Takes the port exclusively for the duration of any operation, so the
// terminal session is torn down on entry and reopened after.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  open as openFileDialog,
  save as saveFileDialog,
} from "@tauri-apps/plugin-dialog";
import { listen } from "@tauri-apps/api/event";
import { BookOpen, FileUp, Play, Save, ShieldAlert, Trash2, X } from "lucide-react";
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
  flasherStm32Cancel,
  flasherStm32DetectChip,
  flasherStm32Erase,
  flasherStm32Flash,
  flasherStm32ReadFlash,
} from "../../../api/flashers";
import { tlog } from "../../../api/settings";
import { useSerialStore, type Stm32Operation } from "../stores/serialStore";
import type {
  FlasherProgressEvent,
  Stm32PinSelection,
} from "../utils/flasherTypes";

interface Props {
  /** Hand the port over from the terminal to a flasher op. The parent
   * remembers whether the terminal was open and reopens it once the op
   * settles, so swapping tabs / kicking off a detect is non-destructive. */
  onBeforeFlash: () => Promise<void>;
  /** True while the Terminal tab has the port open. We skip the eager
   * auto-detect in that case so the live session isn't interrupted. */
  isTerminalOpen: boolean;
}

const PIN_OPTIONS: { value: Stm32PinSelection; label: string }[] = [
  { value: "dtr", label: "DTR" },
  { value: "rts", label: "RTS" },
  { value: "none", label: "None" },
];

const BAUD_OPTIONS = [9600, 19200, 38400, 57600, 115200];

const DEFAULT_FLASH_BASE = "0x08000000";

export default function Stm32FlashView({ onBeforeFlash, isTerminalOpen }: Props) {
  const settings = useSerialStore((s) => s.settings);
  const stm32Flash = useSerialStore((s) => s.stm32Flash);
  const setStm32Flash = useSerialStore((s) => s.setStm32Flash);
  const appendLog = useSerialStore((s) => s.appendStm32Log);
  const reset = useSerialStore((s) => s.resetStm32Flash);
  const operation = useSerialStore((s) => s.stm32Operation);
  const setOperation = useSerialStore((s) => s.setStm32Operation);
  const options = useSerialStore((s) => s.stm32Options);
  const setOptions = useSerialStore((s) => s.setStm32Options);
  const chip = useSerialStore((s) => s.stm32Chip);
  const setChip = useSerialStore((s) => s.setStm32Chip);

  const [imagePath, setImagePath] = useState<string | null>(null);
  const [address, setAddress] = useState(DEFAULT_FLASH_BASE);
  const [backupPath, setBackupPath] = useState<string | null>(null);
  const [backupOffset, setBackupOffset] = useState(DEFAULT_FLASH_BASE);
  const [backupSize, setBackupSize] = useState("");
  const [backupFullChip, setBackupFullChip] = useState(true);
  const [eraseConfirm, setEraseConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const autoDetectedRef = useRef<string | null>(null);

  // Intel HEX records carry their own addresses, so ignore the address field.
  const isHex = imagePath?.toLowerCase().endsWith(".hex") ?? false;

  // Subscribe to flasher progress events for the active flash id only.
  useEffect(() => {
    const id = stm32Flash.flashId;
    if (!id) return;
    const unlistenPromise = listen<FlasherProgressEvent>(
      FLASHER_PROGRESS_EVENT,
      (event) => {
        const p = event.payload;
        if (p.flash_id !== id) return;
        setStm32Flash({
          phase: p.phase,
          bytesDone: p.bytes_done,
          bytesTotal: p.bytes_total,
          error: p.phase === "error" ? p.message ?? "Operation failed" : null,
        });
        if (p.message) appendLog(`[${p.phase}] ${p.message}`);
      },
    );
    return () => {
      unlistenPromise.then((fn) => fn()).catch(() => {});
    };
  }, [stm32Flash.flashId, setStm32Flash, appendLog]);

  const detect = useCallback(
    async (silent = false) => {
      if (!settings.port) return;
      setBusy(true);
      try {
        await onBeforeFlash();
        const info = await flasherStm32DetectChip(settings.port, options);
        setChip(info);
        if (!silent) {
          appendLog(
            `Detected ${info.chip} (PID 0x${info.pid.toString(16).toUpperCase().padStart(4, "0")}, BL v${info.bootloader_version})`,
          );
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        tlog.info(`[Serial/STM32] detect failed: ${msg}`);
        if (!silent) appendLog(`Detect failed: ${msg}`);
        setChip(null);
      } finally {
        setBusy(false);
      }
    },
    [settings.port, options, onBeforeFlash, appendLog, setChip],
  );

  // Auto-detect when the user lands on this tab with a port selected, and
  // whenever the port changes — keyed off the port name so we don't keep
  // re-detecting the same one. Skipped while the Terminal tab is using the
  // port so flipping between tabs doesn't interrupt a live session.
  useEffect(() => {
    if (!settings.port) {
      autoDetectedRef.current = null;
      return;
    }
    if (isTerminalOpen) return;
    if (autoDetectedRef.current === settings.port) return;
    if (busy || stm32Flash.phase === "writing" || stm32Flash.phase === "erasing") {
      return;
    }
    autoDetectedRef.current = settings.port;
    void detect(true);
  }, [settings.port, isTerminalOpen, busy, stm32Flash.phase, detect]);

  const pickImage = useCallback(async () => {
    const selected = await openFileDialog({
      multiple: false,
      filters: [{ name: "Firmware", extensions: ["bin", "hex"] }],
    });
    if (typeof selected === "string") setImagePath(selected);
  }, []);

  const pickBackupPath = useCallback(async () => {
    const selected = await saveFileDialog({
      filters: [{ name: "Flash dump", extensions: ["bin"] }],
      defaultPath: "stm32-flash-dump.bin",
    });
    if (typeof selected === "string") setBackupPath(selected);
  }, []);

  const flash = useCallback(async () => {
    if (!settings.port || !imagePath) return;
    // .hex carries its own addresses — pass 0 as the placeholder base. The
    // backend ignores it for .hex.
    const addr = isHex ? 0 : parseHexOrDec(address);
    if (addr === null) {
      appendLog(`Invalid address: ${address}`);
      return;
    }
    setBusy(true);
    reset();
    try {
      await onBeforeFlash();
      const flashId = await flasherStm32Flash(
        settings.port,
        imagePath,
        addr,
        options,
      );
      setStm32Flash({ flashId, phase: "connecting" });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      tlog.info(`[Serial/STM32] flash failed: ${msg}`);
      appendLog(`Flash failed: ${msg}`);
      setStm32Flash({ phase: "error", error: msg });
    } finally {
      setBusy(false);
    }
  }, [settings.port, imagePath, isHex, address, options, onBeforeFlash, reset, setStm32Flash, appendLog]);

  const backup = useCallback(async () => {
    if (!settings.port || !backupPath) return;
    const offset = parseHexOrDec(backupOffset);
    if (offset === null) {
      appendLog(`Invalid offset: ${backupOffset}`);
      return;
    }
    let size: number | null = null;
    if (backupFullChip) {
      // If we know the chip's flash size, prefer that — otherwise the
      // backend falls back to its own PID lookup.
      if (chip?.flash_size_kb) size = chip.flash_size_kb * 1024;
    } else {
      const parsed = parseHexOrDec(backupSize);
      if (parsed === null || parsed <= 0) {
        appendLog(`Invalid size: ${backupSize}`);
        return;
      }
      size = parsed;
    }
    setBusy(true);
    reset();
    try {
      await onBeforeFlash();
      const flashId = await flasherStm32ReadFlash(
        settings.port,
        backupPath,
        offset,
        size,
        options,
      );
      setStm32Flash({ flashId, phase: "connecting" });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      tlog.info(`[Serial/STM32] backup failed: ${msg}`);
      appendLog(`Backup failed: ${msg}`);
      setStm32Flash({ phase: "error", error: msg });
    } finally {
      setBusy(false);
    }
  }, [settings.port, backupPath, backupOffset, backupSize, backupFullChip, chip, options, onBeforeFlash, reset, setStm32Flash, appendLog]);

  const erase = useCallback(async () => {
    if (!settings.port) return;
    setBusy(true);
    reset();
    setEraseConfirm(false);
    try {
      await onBeforeFlash();
      const flashId = await flasherStm32Erase(settings.port, options);
      setStm32Flash({ flashId, phase: "connecting" });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      tlog.info(`[Serial/STM32] erase failed: ${msg}`);
      appendLog(`Erase failed: ${msg}`);
      setStm32Flash({ phase: "error", error: msg });
    } finally {
      setBusy(false);
    }
  }, [settings.port, options, onBeforeFlash, reset, setStm32Flash, appendLog]);

  const cancel = useCallback(async () => {
    if (!stm32Flash.flashId) return;
    try {
      await flasherStm32Cancel(stm32Flash.flashId);
    } catch (err) {
      tlog.info(`[Serial/STM32] cancel failed: ${err}`);
    }
  }, [stm32Flash.flashId]);

  const progressPct = useMemo(() => {
    if (!stm32Flash.bytesTotal) return 0;
    return Math.min(
      100,
      Math.round((stm32Flash.bytesDone / stm32Flash.bytesTotal) * 100),
    );
  }, [stm32Flash.bytesDone, stm32Flash.bytesTotal]);

  const inProgress =
    stm32Flash.phase !== "idle" &&
    stm32Flash.phase !== "done" &&
    stm32Flash.phase !== "error" &&
    stm32Flash.phase !== "cancelled";

  const phaseLabel = useMemo(() => {
    if (operation === "backup" && stm32Flash.phase === "writing") {
      return "reading";
    }
    return stm32Flash.phase;
  }, [operation, stm32Flash.phase]);

  const rdpLocked = chip?.rdp_level?.toLowerCase().includes("lock") ?? false;

  return (
    <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
      {/* Mode toggle */}
      <div className={`flex ${bgSurface} ${borderDivider} border-b px-3 py-2 gap-1`}>
        {(
          [
            { id: "flash", label: "Flash", icon: Play },
            { id: "backup", label: "Backup", icon: Save },
            { id: "erase", label: "Erase", icon: Trash2 },
          ] as const
        ).map((m) => {
          const ModeIcon = m.icon;
          const active = operation === (m.id as Stm32Operation);
          return (
            <button
              key={m.id}
              onClick={() => setOperation(m.id as Stm32Operation)}
              disabled={inProgress}
              className={`flex items-center gap-1 text-xs px-3 py-1 rounded ${
                active
                  ? "bg-sky-500/20 text-sky-300"
                  : `${textSecondary} hover:text-[color:var(--text-primary)]`
              } disabled:opacity-40 disabled:cursor-not-allowed`}
            >
              <ModeIcon size={12} />
              {m.label}
            </button>
          );
        })}
      </div>

      {/* Chip status bar */}
      <div
        className={`flex items-center gap-3 px-3 py-2 ${borderDivider} border-b text-xs ${textSecondary}`}
      >
        <BookOpen size={14} className="text-amber-300" />
        {chip ? (
          <>
            <span className={`font-medium ${textPrimary}`}>{chip.chip}</span>
            <span className="font-mono">
              · PID 0x{chip.pid.toString(16).toUpperCase().padStart(4, "0")}
            </span>
            <span>· BL v{chip.bootloader_version}</span>
            {chip.flash_size_kb ? (
              <span>· {chip.flash_size_kb} KB flash</span>
            ) : null}
            {rdpLocked ? (
              <span className="flex items-center gap-1 px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-300 text-[10px] uppercase tracking-wide">
                <ShieldAlert size={10} /> RDP {chip.rdp_level}
              </span>
            ) : null}
          </>
        ) : (
          <span className={textMuted}>
            {settings.port
              ? busy
                ? "Detecting…"
                : "Chip not detected — click Detect to try again"
              : "Connect a serial port to detect the chip"}
          </span>
        )}
        <button
          onClick={() => detect(false)}
          disabled={!settings.port || busy || inProgress}
          className="ml-auto flex items-center gap-1 text-xs px-2 py-0.5 rounded bg-amber-500/20 text-amber-300 hover:bg-amber-500/30 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          Detect
        </button>
      </div>

      {/* Common options row — bootloader-entry pin map + baud */}
      <div
        className={`p-3 ${bgSurface} ${borderDivider} border-b grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3`}
      >
        <Field label="BOOT0 pin">
          <Select
            value={options.boot0_pin ?? "dtr"}
            onChange={(v) =>
              setOptions({ boot0_pin: v as Stm32PinSelection })
            }
            options={PIN_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
          />
        </Field>
        <Field label="RESET pin">
          <Select
            value={options.reset_pin ?? "rts"}
            onChange={(v) =>
              setOptions({ reset_pin: v as Stm32PinSelection })
            }
            options={PIN_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
          />
        </Field>
        <Field label="Invert BOOT0">
          <label
            className={`flex items-center gap-1 text-xs ${textSecondary} px-1 py-1 cursor-pointer`}
          >
            <input
              type="checkbox"
              checked={options.boot0_invert ?? false}
              onChange={(e) => setOptions({ boot0_invert: e.target.checked })}
            />
            Active low
          </label>
        </Field>
        <Field label="Invert RESET">
          <label
            className={`flex items-center gap-1 text-xs ${textSecondary} px-1 py-1 cursor-pointer`}
          >
            <input
              type="checkbox"
              checked={options.reset_invert ?? true}
              onChange={(e) => setOptions({ reset_invert: e.target.checked })}
            />
            Active low
          </label>
        </Field>
        <Field label="Baud">
          <Select
            value={String(options.baud ?? 115_200)}
            onChange={(v) => setOptions({ baud: Number(v) })}
            options={BAUD_OPTIONS.map((b) => ({
              value: String(b),
              label: b.toLocaleString("en-AU"),
            }))}
          />
        </Field>
      </div>

      {/* Operation-specific controls */}
      {operation === "flash" && (
        <div
          className={`p-3 ${bgSurface} ${borderDivider} border-b flex flex-wrap gap-3 items-end`}
        >
          <Field label="Image">
            <button
              onClick={pickImage}
              className={`flex items-center gap-1 text-xs px-2 py-1 rounded ${bgPrimary} ${textPrimary} border ${borderDivider} hover:bg-[var(--hover-bg)]`}
            >
              <FileUp size={12} />
              {imagePath ?? "Choose .bin / .hex"}
            </button>
          </Field>
          <Field label="Flash address">
            <input
              value={isHex ? "(from .hex)" : address}
              onChange={(e) => setAddress(e.target.value)}
              disabled={isHex}
              className={`${bgPrimary} ${textPrimary} text-xs px-2 py-1 rounded border ${borderDivider} font-mono w-32 disabled:opacity-50`}
            />
          </Field>
          <div className="ml-auto">
            {inProgress ? (
              <ActionButton variant="cancel" onClick={cancel}>
                <X size={12} /> Cancel
              </ActionButton>
            ) : (
              <ActionButton
                variant="primary"
                onClick={flash}
                disabled={!settings.port || !imagePath || busy}
              >
                <Play size={12} /> Flash
              </ActionButton>
            )}
          </div>
        </div>
      )}

      {operation === "backup" && (
        <div
          className={`p-3 ${bgSurface} ${borderDivider} border-b flex flex-wrap gap-3 items-end`}
        >
          <Field label="Output file">
            <button
              onClick={pickBackupPath}
              className={`flex items-center gap-1 text-xs px-2 py-1 rounded ${bgPrimary} ${textPrimary} border ${borderDivider} hover:bg-[var(--hover-bg)]`}
            >
              <Save size={12} />
              {backupPath ?? "Choose .bin"}
            </button>
          </Field>
          <Field label="Offset">
            <input
              value={backupOffset}
              onChange={(e) => setBackupOffset(e.target.value)}
              className={`${bgPrimary} ${textPrimary} text-xs px-2 py-1 rounded border ${borderDivider} font-mono w-32`}
            />
          </Field>
          <Field label="Size">
            {backupFullChip ? (
              <div className={`text-xs ${textMuted} px-2 py-1`}>
                Full chip
                {chip?.flash_size_kb ? ` (${chip.flash_size_kb} KB)` : ""}
              </div>
            ) : (
              <input
                value={backupSize}
                onChange={(e) => setBackupSize(e.target.value)}
                placeholder="0x10000"
                className={`${bgPrimary} ${textPrimary} text-xs px-2 py-1 rounded border ${borderDivider} font-mono w-32`}
              />
            )}
          </Field>
          <label
            className={`flex items-center gap-1 text-xs ${textSecondary} cursor-pointer`}
          >
            <input
              type="checkbox"
              checked={backupFullChip}
              onChange={(e) => setBackupFullChip(e.target.checked)}
            />
            Full chip
          </label>
          {rdpLocked ? (
            <div className="flex items-center gap-1 text-xs text-amber-300">
              <ShieldAlert size={12} />
              Read protection is on — backup will fail until RDP is cleared.
            </div>
          ) : null}
          <div className="ml-auto">
            {inProgress ? (
              <ActionButton variant="cancel" onClick={cancel}>
                <X size={12} /> Cancel
              </ActionButton>
            ) : (
              <ActionButton
                variant="primary"
                onClick={backup}
                disabled={!settings.port || !backupPath || busy}
              >
                <Save size={12} /> Read flash
              </ActionButton>
            )}
          </div>
        </div>
      )}

      {operation === "erase" && (
        <div
          className={`p-3 ${bgSurface} ${borderDivider} border-b flex flex-wrap gap-3 items-center`}
        >
          <div className={`text-xs ${textSecondary}`}>
            Mass-erases the entire flash. The device will need fresh firmware
            after this completes. Mass-erase also clears RDP if it was set.
          </div>
          <div className="ml-auto flex items-center gap-2">
            {inProgress ? (
              <ActionButton variant="cancel" onClick={cancel}>
                <X size={12} /> Cancel
              </ActionButton>
            ) : eraseConfirm ? (
              <>
                <span className="text-xs text-[color:var(--text-danger)]">
                  Confirm wipe?
                </span>
                <ActionButton
                  variant="cancel"
                  onClick={() => setEraseConfirm(false)}
                >
                  No
                </ActionButton>
                <ActionButton
                  variant="danger"
                  onClick={erase}
                  disabled={!settings.port || busy}
                >
                  <Trash2 size={12} /> Yes, erase
                </ActionButton>
              </>
            ) : (
              <ActionButton
                variant="danger"
                onClick={() => setEraseConfirm(true)}
                disabled={!settings.port || busy}
              >
                <Trash2 size={12} /> Erase entire flash
              </ActionButton>
            )}
          </div>
        </div>
      )}

      {(inProgress ||
        stm32Flash.phase === "done" ||
        stm32Flash.phase === "error" ||
        stm32Flash.phase === "cancelled") && (
        <div className={`px-3 py-2 ${borderDivider} border-b`}>
          <div className={`text-xs ${textSecondary} mb-1 capitalize`}>
            {phaseLabel}
            {stm32Flash.bytesTotal > 0 && (
              <>
                {" "}
                — {progressPct}% (
                {stm32Flash.bytesDone.toLocaleString("en-AU")}/
                {stm32Flash.bytesTotal.toLocaleString("en-AU")} bytes)
              </>
            )}
          </div>
          {stm32Flash.bytesTotal > 0 && (
            <div className="h-2 rounded bg-[var(--bg-primary)] overflow-hidden">
              <div
                className="h-full bg-amber-400 transition-all"
                style={{ width: `${progressPct}%` }}
              />
            </div>
          )}
          {stm32Flash.error && (
            <div className="text-xs text-[color:var(--text-danger)] mt-1">
              {stm32Flash.error}
            </div>
          )}
        </div>
      )}

      <div className="flex-1 overflow-y-auto p-3 font-mono text-xs">
        {stm32Flash.log.length === 0 ? (
          <div className={textMuted}>
            {operation === "flash"
              ? "Pick a .bin or .hex and click Flash. The terminal will be disconnected for the duration of the operation."
              : operation === "backup"
                ? "Choose an output file and click Read flash. Use Full chip to dump everything. Read-protected chips (RDP > 0) cannot be backed up."
                : "Click Erase entire flash to wipe the chip. This is destructive but also unlocks RDP."}
          </div>
        ) : (
          stm32Flash.log.map((line, i) => (
            <div key={i} className={textPrimary}>
              {line}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

function parseHexOrDec(input: string): number | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const radix = trimmed.toLowerCase().startsWith("0x") ? 16 : 10;
  const value = parseInt(trimmed, radix);
  return Number.isNaN(value) ? null : value;
}

interface FieldProps {
  label: string;
  children: React.ReactNode;
}

function Field({ label, children }: FieldProps) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[10px] uppercase tracking-wide text-[color:var(--text-muted)]">
        {label}
      </span>
      {children}
    </div>
  );
}

interface SelectProps {
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string }[];
}

function Select({ value, onChange, options }: SelectProps) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={`${bgPrimary} ${textPrimary} text-xs px-2 py-1 rounded border ${borderDivider}`}
    >
      {options.map((opt) => (
        <option key={opt.value} value={opt.value}>
          {opt.label}
        </option>
      ))}
    </select>
  );
}

interface ActionButtonProps {
  variant: "primary" | "cancel" | "danger";
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}

function ActionButton({ variant, onClick, disabled, children }: ActionButtonProps) {
  const styles =
    variant === "primary"
      ? "bg-amber-500/20 text-amber-300 hover:bg-amber-500/30"
      : variant === "danger"
        ? "bg-red-500/30 text-red-200 hover:bg-red-500/40"
        : "bg-red-500/20 text-red-300 hover:bg-red-500/30";
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`flex items-center gap-1 text-xs px-3 py-1.5 rounded ${styles} disabled:opacity-40 disabled:cursor-not-allowed`}
    >
      {children}
    </button>
  );
}
