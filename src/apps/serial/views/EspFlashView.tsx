// ui/src/apps/serial/views/EspFlashView.tsx
//
// ESP32-family flasher — wraps Espressif's esptool protocol via the
// `espflash` Rust crate. Three operations live in this single view, behind
// a segmented control: write a firmware image (`flash`), dump flash to a
// file (`backup`), and wipe the chip (`erase`). Chip detection is the
// primary path — the status bar at the top auto-populates the moment the
// user enters this tab with a port selected, so the rest of the form
// can be filled in with sensible defaults.
//
// Takes the port exclusively for the duration of any operation, so the
// terminal session is torn down on entry and may be reconnected after.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  open as openFileDialog,
  save as saveFileDialog,
} from "@tauri-apps/plugin-dialog";
import { listen } from "@tauri-apps/api/event";
import { Cpu, FileUp, Play, Save, Trash2, X } from "lucide-react";
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
  flasherEspErase,
  flasherEspFlash,
  flasherEspReadFlash,
} from "../../../api/flashers";
import { tlog } from "../../../api/settings";
import { useSerialStore, type EspOperation } from "../stores/serialStore";
import type { FlasherProgressEvent } from "../utils/flasherTypes";

interface Props {
  /** Hand the port over from the terminal to a flasher op. The parent
   * remembers whether the terminal was open and reopens it once the op
   * settles, so swapping tabs / kicking off a detect is non-destructive. */
  onBeforeFlash: () => Promise<void>;
  /** True while the Terminal tab has the port open. We skip the eager
   * auto-detect in that case so the live session isn't interrupted. */
  isTerminalOpen: boolean;
}

const CHIP_OPTIONS = [
  { value: "auto", label: "Auto-detect" },
  { value: "esp32", label: "ESP32" },
  { value: "esp32s2", label: "ESP32-S2" },
  { value: "esp32s3", label: "ESP32-S3" },
  { value: "esp32c2", label: "ESP32-C2" },
  { value: "esp32c3", label: "ESP32-C3" },
  { value: "esp32c5", label: "ESP32-C5" },
  { value: "esp32c6", label: "ESP32-C6" },
  { value: "esp32c61", label: "ESP32-C61" },
  { value: "esp32h2", label: "ESP32-H2" },
  { value: "esp32p4", label: "ESP32-P4" },
] as const;

const FLASH_BAUD_OPTIONS = [
  115_200,
  230_400,
  460_800,
  921_600,
  1_500_000,
  2_000_000,
];

const FLASH_MODE_OPTIONS = ["dio", "qio", "qout", "dout"] as const;
const FLASH_FREQ_OPTIONS = ["20MHz", "26MHz", "40MHz", "80MHz"] as const;
const FLASH_SIZE_OPTIONS = [
  { value: "auto", label: "Auto" },
  { value: "1MB", label: "1 MB" },
  { value: "2MB", label: "2 MB" },
  { value: "4MB", label: "4 MB" },
  { value: "8MB", label: "8 MB" },
  { value: "16MB", label: "16 MB" },
  { value: "32MB", label: "32 MB" },
] as const;

export default function EspFlashView({ onBeforeFlash, isTerminalOpen }: Props) {
  const settings = useSerialStore((s) => s.settings);
  const espFlash = useSerialStore((s) => s.espFlash);
  const setEspFlash = useSerialStore((s) => s.setEspFlash);
  const appendLog = useSerialStore((s) => s.appendEspLog);
  const reset = useSerialStore((s) => s.resetEspFlash);
  const operation = useSerialStore((s) => s.espOperation);
  const setOperation = useSerialStore((s) => s.setEspOperation);
  const options = useSerialStore((s) => s.espOptions);
  const setOptions = useSerialStore((s) => s.setEspOptions);
  const chip = useSerialStore((s) => s.espChip);
  const setChip = useSerialStore((s) => s.setEspChip);

  const [imagePath, setImagePath] = useState<string | null>(null);
  const [address, setAddress] = useState("0x0");
  const [backupPath, setBackupPath] = useState<string | null>(null);
  const [backupOffset, setBackupOffset] = useState("0x0");
  const [backupSize, setBackupSize] = useState("");
  const [backupFullChip, setBackupFullChip] = useState(true);
  const [eraseConfirm, setEraseConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const autoDetectedRef = useRef<string | null>(null);

  // Subscribe to flasher progress events for the active flash id only.
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
          error: p.phase === "error" ? p.message ?? "Operation failed" : null,
        });
        if (p.message) appendLog(`[${p.phase}] ${p.message}`);
      },
    );
    return () => {
      unlistenPromise.then((fn) => fn()).catch(() => {});
    };
  }, [espFlash.flashId, setEspFlash, appendLog]);

  const detect = useCallback(
    async (silent = false) => {
      if (!settings.port) return;
      setBusy(true);
      try {
        await onBeforeFlash();
        const info = await flasherEspDetectChip(settings.port, options);
        setChip(info);
        if (!silent) appendLog(`Detected ${info.chip} (${info.mac})`);
        // Populate the flash-size default the first time only — leave any
        // user override alone on subsequent detects.
        if (!options.flash_size && info.flash_size_bytes) {
          const mb = Math.round(info.flash_size_bytes / 1024 / 1024);
          const match = FLASH_SIZE_OPTIONS.find(
            (opt) => opt.value === `${mb}MB`,
          );
          if (match) setOptions({ flash_size: match.value });
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        tlog.info(`[Serial/ESP] detect failed: ${msg}`);
        if (!silent) appendLog(`Detect failed: ${msg}`);
        setChip(null);
      } finally {
        setBusy(false);
      }
    },
    [settings.port, options, onBeforeFlash, appendLog, setChip, setOptions],
  );

  // Auto-detect when the user lands on this tab with a port selected, and
  // whenever the port changes — keyed off the port name so we don't keep
  // re-detecting the same one. Skipped while the Terminal tab is using the
  // port so flipping between tabs doesn't interrupt a live session — the
  // user can still hit Detect manually (which will hand the port over and
  // reopen the terminal afterwards).
  useEffect(() => {
    if (!settings.port) {
      autoDetectedRef.current = null;
      return;
    }
    if (isTerminalOpen) return;
    if (autoDetectedRef.current === settings.port) return;
    if (busy || espFlash.phase === "writing" || espFlash.phase === "erasing") {
      return;
    }
    autoDetectedRef.current = settings.port;
    void detect(true);
  }, [settings.port, isTerminalOpen, busy, espFlash.phase, detect]);

  const pickImage = useCallback(async () => {
    const selected = await openFileDialog({
      multiple: false,
      filters: [{ name: "Firmware", extensions: ["bin", "elf"] }],
    });
    if (typeof selected === "string") setImagePath(selected);
  }, []);

  const pickBackupPath = useCallback(async () => {
    const selected = await saveFileDialog({
      filters: [{ name: "Flash dump", extensions: ["bin"] }],
      defaultPath: "esp-flash-dump.bin",
    });
    if (typeof selected === "string") setBackupPath(selected);
  }, []);

  const flash = useCallback(async () => {
    if (!settings.port || !imagePath) return;
    const addr = parseHexOrDec(address);
    if (addr === null) {
      appendLog(`Invalid address: ${address}`);
      return;
    }
    setBusy(true);
    reset();
    try {
      await onBeforeFlash();
      const flashId = await flasherEspFlash(
        settings.port,
        imagePath,
        addr,
        options,
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
  }, [settings.port, imagePath, address, options, onBeforeFlash, reset, setEspFlash, appendLog]);

  const backup = useCallback(async () => {
    if (!settings.port || !backupPath) return;
    const offset = parseHexOrDec(backupOffset);
    if (offset === null) {
      appendLog(`Invalid offset: ${backupOffset}`);
      return;
    }
    let size: number | null = null;
    if (!backupFullChip) {
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
      const flashId = await flasherEspReadFlash(
        settings.port,
        backupPath,
        offset,
        size,
        options,
      );
      setEspFlash({ flashId, phase: "connecting" });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      tlog.info(`[Serial/ESP] backup failed: ${msg}`);
      appendLog(`Backup failed: ${msg}`);
      setEspFlash({ phase: "error", error: msg });
    } finally {
      setBusy(false);
    }
  }, [settings.port, backupPath, backupOffset, backupSize, backupFullChip, options, onBeforeFlash, reset, setEspFlash, appendLog]);

  const erase = useCallback(async () => {
    if (!settings.port) return;
    setBusy(true);
    reset();
    setEraseConfirm(false);
    try {
      await onBeforeFlash();
      const flashId = await flasherEspErase(settings.port, options);
      setEspFlash({ flashId, phase: "connecting" });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      tlog.info(`[Serial/ESP] erase failed: ${msg}`);
      appendLog(`Erase failed: ${msg}`);
      setEspFlash({ phase: "error", error: msg });
    } finally {
      setBusy(false);
    }
  }, [settings.port, options, onBeforeFlash, reset, setEspFlash, appendLog]);

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
    return Math.min(
      100,
      Math.round((espFlash.bytesDone / espFlash.bytesTotal) * 100),
    );
  }, [espFlash.bytesDone, espFlash.bytesTotal]);

  const inProgress =
    espFlash.phase !== "idle" &&
    espFlash.phase !== "done" &&
    espFlash.phase !== "error" &&
    espFlash.phase !== "cancelled";

  const phaseLabel = useMemo(() => {
    if (operation === "backup" && espFlash.phase === "writing") {
      return "reading";
    }
    return espFlash.phase;
  }, [operation, espFlash.phase]);

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
          const active = operation === (m.id as EspOperation);
          return (
            <button
              key={m.id}
              onClick={() => setOperation(m.id as EspOperation)}
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
        <Cpu size={14} className="text-violet-300" />
        {chip ? (
          <>
            <span className={`font-medium ${textPrimary}`}>{chip.chip}</span>
            {chip.flash_size_bytes ? (
              <span>· {Math.round(chip.flash_size_bytes / 1024 / 1024)} MB flash</span>
            ) : null}
            <span>
              · MAC <span className="font-mono">{chip.mac}</span>
            </span>
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
          className="ml-auto flex items-center gap-1 text-xs px-2 py-0.5 rounded bg-violet-500/20 text-violet-300 hover:bg-violet-500/30 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          Detect
        </button>
      </div>

      {/* Common options row */}
      <div
        className={`p-3 ${bgSurface} ${borderDivider} border-b grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3`}
      >
        <Field label="Chip">
          <Select
            value={options.chip ?? "auto"}
            onChange={(v) => setOptions({ chip: v === "auto" ? null : v })}
            options={CHIP_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
          />
        </Field>
        <Field label="Flash baud">
          <Select
            value={String(options.flash_baud ?? 460_800)}
            onChange={(v) => setOptions({ flash_baud: Number(v) })}
            options={FLASH_BAUD_OPTIONS.map((b) => ({
              value: String(b),
              label: b.toLocaleString("en-AU"),
            }))}
          />
        </Field>
        <Field label="Flash mode">
          <Select
            value={options.flash_mode ?? "dio"}
            onChange={(v) => setOptions({ flash_mode: v })}
            options={FLASH_MODE_OPTIONS.map((m) => ({ value: m, label: m }))}
          />
        </Field>
        <Field label="Flash freq">
          <Select
            value={options.flash_freq ?? "40MHz"}
            onChange={(v) => setOptions({ flash_freq: v })}
            options={FLASH_FREQ_OPTIONS.map((f) => ({ value: f, label: f }))}
          />
        </Field>
        <Field label="Flash size">
          <Select
            value={options.flash_size ?? "auto"}
            onChange={(v) => setOptions({ flash_size: v === "auto" ? null : v })}
            options={FLASH_SIZE_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
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
              {imagePath ?? "Choose .bin / .elf"}
            </button>
          </Field>
          <Field label="Flash address">
            <input
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              className={`${bgPrimary} ${textPrimary} text-xs px-2 py-1 rounded border ${borderDivider} font-mono w-28`}
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
              className={`${bgPrimary} ${textPrimary} text-xs px-2 py-1 rounded border ${borderDivider} font-mono w-28`}
            />
          </Field>
          <Field label="Size">
            {backupFullChip ? (
              <div className={`text-xs ${textMuted} px-2 py-1`}>
                Full chip
                {chip?.flash_size_bytes
                  ? ` (${Math.round(chip.flash_size_bytes / 1024 / 1024)} MB)`
                  : ""}
              </div>
            ) : (
              <input
                value={backupSize}
                onChange={(e) => setBackupSize(e.target.value)}
                placeholder="0x100000"
                className={`${bgPrimary} ${textPrimary} text-xs px-2 py-1 rounded border ${borderDivider} font-mono w-28`}
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
            Erases the entire flash chip. The device will need fresh
            firmware after this completes.
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
        espFlash.phase === "done" ||
        espFlash.phase === "error" ||
        espFlash.phase === "cancelled") && (
        <div className={`px-3 py-2 ${borderDivider} border-b`}>
          <div className={`text-xs ${textSecondary} mb-1 capitalize`}>
            {phaseLabel}
            {espFlash.bytesTotal > 0 && (
              <>
                {" "}
                — {progressPct}% ({espFlash.bytesDone.toLocaleString("en-AU")}/
                {espFlash.bytesTotal.toLocaleString("en-AU")} bytes)
              </>
            )}
          </div>
          {espFlash.bytesTotal > 0 && (
            <div className="h-2 rounded bg-[var(--bg-primary)] overflow-hidden">
              <div
                className="h-full bg-sky-400 transition-all"
                style={{ width: `${progressPct}%` }}
              />
            </div>
          )}
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
            {operation === "flash"
              ? "Pick an image and click Flash to begin. The terminal will be disconnected for the duration of the flash."
              : operation === "backup"
                ? "Choose an output file and click Read flash. Use Full chip to dump everything."
                : "Click Erase entire flash to wipe the chip. This is destructive."}
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
      ? "bg-sky-500/20 text-sky-300 hover:bg-sky-500/30"
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
