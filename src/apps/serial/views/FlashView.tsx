// src/apps/serial/views/FlashView.tsx
//
// Unified Flash view. Identical UI for every supported chip family — only
// the driver-specific OptionsPanel differs. The active driver is chosen by
// chip detection (auto-run on tab entry / device change, manual re-run from
// the Detect button) and drives the rest of the view: capabilities gate
// the Flash / Backup / Erase modes, image extensions feed the open dialog,
// `describeChip` populates the status bar, and the driver's flash/backup/
// erase functions read their own option slice from the store internally.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  open as openFileDialog,
  save as saveFileDialog,
} from "@tauri-apps/plugin-dialog";
import {
  Cpu,
  FileUp,
  Play,
  Save,
  ShieldAlert,
  Trash2,
  X,
} from "lucide-react";

import {
  FLASHER_PROGRESS_EVENT,
} from "../../../api/flashers";
import { tlog } from "../../../api/settings";
import ManufacturerBadge from "../../../components/ManufacturerBadge";
import {
  bgPrimary,
  bgSurface,
  borderDivider,
  textMuted,
  textPrimary,
  textSecondary,
} from "../../../styles/colourTokens";
import { useFlasherStore } from "../stores/flasherStore";
import { getDriver } from "../flashers/registry";
import {
  ActionButton,
  Field,
  TextInput,
  parseHexOrDec,
} from "../flashers/formHelpers";
import { useChipDetection } from "../flashers/useChipDetection";
import type { DeviceHandle, Operation } from "../flashers/types";
import type {
  DfuDeviceInfo,
  FlasherProgressEvent,
} from "../utils/flasherTypes";

interface Props {
  /** Active serial port name (null when the user picked a DFU device). */
  serialPort: string | null;
  /** Currently selected DFU device — picked up from the shared picker. */
  dfuDevice: DfuDeviceInfo | null;
  /** True while the Terminal tab has the port open. */
  isTerminalOpen: boolean;
  /** Hand the port over from the terminal before any flash operation. */
  onBeforeFlash: () => Promise<void>;
}

export default function FlashView({
  serialPort,
  dfuDevice,
  isTerminalOpen,
  onBeforeFlash,
}: Props) {
  const activeDriverId = useFlasherStore((s) => s.activeDriverId);
  const operation = useFlasherStore((s) => s.operation);
  const setOperation = useFlasherStore((s) => s.setOperation);
  const chip = useFlasherStore((s) => s.chip);
  const flash = useFlasherStore((s) => s.flash);
  const setFlash = useFlasherStore((s) => s.setFlash);
  const appendLog = useFlasherStore((s) => s.appendLog);
  const reset = useFlasherStore((s) => s.resetFlash);

  const driver = getDriver(activeDriverId);

  const detection = useChipDetection({
    serialPort,
    dfuDevice,
    isTerminalOpen,
    onBeforeProbe: onBeforeFlash,
  });

  const [imagePath, setImagePath] = useState<string | null>(null);
  const [address, setAddress] = useState("");
  const [backupPath, setBackupPath] = useState<string | null>(null);
  const [backupOffset, setBackupOffset] = useState("");
  const [backupSize, setBackupSize] = useState("");
  const [backupFullChip, setBackupFullChip] = useState(true);
  const [eraseConfirm, setEraseConfirm] = useState(false);
  const [busy, setBusy] = useState(false);

  // Reset the address fields to the active driver's default whenever the
  // driver changes — STM32 lives at 0x08000000, ESP at 0x0, etc.
  useEffect(() => {
    if (!driver) return;
    const hex = `0x${driver.defaultFlashAddress.toString(16).padStart(2, "0")}`;
    setAddress(hex);
    setBackupOffset(hex);
  }, [driver?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Snap to a still-supported operation when switching drivers — e.g. DFU
  // doesn't support backup or erase, so flip back to flash.
  useEffect(() => {
    if (!driver) return;
    if (!driver.capabilities[operation]) {
      setOperation("flash");
    }
  }, [driver, operation, setOperation]);

  // Subscribe to flasher progress events for the active flash id only.
  useEffect(() => {
    const id = flash.flashId;
    if (!id) return;
    const unlistenPromise = listen<FlasherProgressEvent>(
      FLASHER_PROGRESS_EVENT,
      (event) => {
        const p = event.payload;
        if (p.flash_id !== id) return;
        setFlash({
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
  }, [flash.flashId, setFlash, appendLog]);

  // .hex / .dfu carry their own addresses, so disable the address field.
  const isAddressEmbedded = useMemo(() => {
    if (!imagePath) return false;
    const lower = imagePath.toLowerCase();
    return lower.endsWith(".hex") || lower.endsWith(".dfu");
  }, [imagePath]);

  const inProgress =
    flash.phase !== "idle" &&
    flash.phase !== "done" &&
    flash.phase !== "error" &&
    flash.phase !== "cancelled";

  const progressPct = useMemo(() => {
    if (!flash.bytesTotal) return 0;
    return Math.min(
      100,
      Math.round((flash.bytesDone / flash.bytesTotal) * 100),
    );
  }, [flash.bytesDone, flash.bytesTotal]);

  // "writing" is the wrong word during a backup — we're reading. Same for
  // "erasing" → an erase op shows it correctly, but a flash op might pass
  // through erasing as a step.
  const phaseLabel = useMemo(() => {
    if (operation === "backup" && flash.phase === "writing") return "reading";
    return flash.phase;
  }, [operation, flash.phase]);

  const handle = useMemo<DeviceHandle | null>(() => {
    if (!driver) return null;
    if (driver.transport === "serial") {
      return serialPort ? { kind: "serial", port: serialPort } : null;
    }
    return dfuDevice ? { kind: "dfu", serial: dfuDevice.serial } : null;
  }, [driver, serialPort, dfuDevice]);

  const pickImage = useCallback(async () => {
    if (!driver) return;
    const selected = await openFileDialog({
      multiple: false,
      filters: [{ name: "Firmware", extensions: [...driver.imageExtensions] }],
    });
    if (typeof selected === "string") setImagePath(selected);
  }, [driver]);

  const pickBackupPath = useCallback(async () => {
    if (!driver) return;
    const selected = await saveFileDialog({
      filters: [
        { name: "Flash dump", extensions: [driver.backupExtension] },
      ],
      defaultPath: `${driver.id}-flash-dump.${driver.backupExtension}`,
    });
    if (typeof selected === "string") setBackupPath(selected);
  }, [driver]);

  const startFlash = useCallback(async () => {
    if (!driver || !handle || !imagePath) return;
    const addr = isAddressEmbedded ? 0 : parseHexOrDec(address);
    if (addr === null) {
      appendLog(`Invalid address: ${address}`);
      return;
    }
    setBusy(true);
    reset();
    try {
      if (driver.transport === "serial") await onBeforeFlash();
      const flashId = await driver.flash(handle, {
        imagePath,
        address: addr,
      });
      setFlash({ flashId, phase: "connecting" });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      tlog.info(`[Serial/Flash] flash failed: ${msg}`);
      appendLog(`Flash failed: ${msg}`);
      setFlash({ phase: "error", error: msg });
    } finally {
      setBusy(false);
    }
  }, [
    driver,
    handle,
    imagePath,
    isAddressEmbedded,
    address,
    appendLog,
    onBeforeFlash,
    reset,
    setFlash,
  ]);

  const startBackup = useCallback(async () => {
    if (!driver?.backup || !handle || !backupPath) return;
    const offset = parseHexOrDec(backupOffset);
    if (offset === null) {
      appendLog(`Invalid offset: ${backupOffset}`);
      return;
    }
    let size: number | null = null;
    if (backupFullChip) {
      // If we know the chip's flash size, prefer that. Otherwise pass null
      // and let the backend fall back to its own lookup.
      if (chip?.flashSizeKb) size = chip.flashSizeKb * 1024;
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
      if (driver.transport === "serial") await onBeforeFlash();
      const flashId = await driver.backup(handle, {
        outputPath: backupPath,
        offset,
        size,
      });
      setFlash({ flashId, phase: "connecting" });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      tlog.info(`[Serial/Flash] backup failed: ${msg}`);
      appendLog(`Backup failed: ${msg}`);
      setFlash({ phase: "error", error: msg });
    } finally {
      setBusy(false);
    }
  }, [
    driver,
    handle,
    backupPath,
    backupOffset,
    backupSize,
    backupFullChip,
    chip,
    appendLog,
    onBeforeFlash,
    reset,
    setFlash,
  ]);

  const startErase = useCallback(async () => {
    if (!driver?.erase || !handle) return;
    setBusy(true);
    reset();
    setEraseConfirm(false);
    try {
      if (driver.transport === "serial") await onBeforeFlash();
      const flashId = await driver.erase(handle);
      setFlash({ flashId, phase: "connecting" });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      tlog.info(`[Serial/Flash] erase failed: ${msg}`);
      appendLog(`Erase failed: ${msg}`);
      setFlash({ phase: "error", error: msg });
    } finally {
      setBusy(false);
    }
  }, [driver, handle, appendLog, onBeforeFlash, reset, setFlash]);

  const cancel = useCallback(async () => {
    if (!driver || !flash.flashId) return;
    try {
      await driver.cancel(flash.flashId);
    } catch (err) {
      tlog.info(`[Serial/Flash] cancel failed: ${err}`);
    }
  }, [driver, flash.flashId]);

  const description = useMemo(() => {
    if (!driver || !chip) return null;
    try {
      return driver.describeChip(chip.raw as never);
    } catch {
      return { label: chip.chipName };
    }
  }, [driver, chip]);

  // Empty state — no driver chosen yet (no port, no DFU device, or detect
  // failed). Mirror the look of the other tabs.
  if (!driver) {
    return (
      <EmptyState
        port={serialPort}
        dfuDevice={dfuDevice}
        busy={detection.busy}
        error={detection.error}
        onDetect={detection.detect}
      />
    );
  }

  const OptionsPanel = driver.OptionsPanel;
  const badge = chip?.manufacturer ?? driver.manufacturer;

  return (
    <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
      {/* Mode toggle — disabled per driver capabilities. */}
      <div
        className={`flex ${bgSurface} ${borderDivider} border-b px-3 py-2 gap-1`}
      >
        {(
          [
            { id: "flash", label: "Flash", icon: Play },
            { id: "backup", label: "Backup", icon: Save },
            { id: "erase", label: "Erase", icon: Trash2 },
          ] as const
        ).map((m) => {
          const ModeIcon = m.icon;
          const active = operation === (m.id as Operation);
          const supported = driver.capabilities[m.id];
          return (
            <button
              key={m.id}
              onClick={() => setOperation(m.id as Operation)}
              disabled={inProgress || !supported}
              className={`flex items-center gap-1 text-xs px-3 py-1 rounded ${
                active
                  ? "bg-sky-500/20 text-sky-300"
                  : `${textSecondary} hover:text-[color:var(--text-primary)]`
              } disabled:opacity-40 disabled:cursor-not-allowed`}
              title={supported ? undefined : `${driver.manufacturer} doesn't support ${m.label.toLowerCase()}`}
            >
              <ModeIcon size={12} />
              {m.label}
            </button>
          );
        })}
      </div>

      {/* Chip status bar — manufacturer badge + describeChip output. */}
      <div
        className={`flex items-center gap-3 px-3 py-2 ${borderDivider} border-b text-xs ${textSecondary}`}
      >
        <Cpu size={14} className="text-violet-300" />
        <ManufacturerBadge manufacturer={badge} />
        {description ? (
          <>
            <span className={`font-medium ${textPrimary}`}>{description.label}</span>
            {description.subline ? (
              <span className={`font-mono ${textMuted}`}>· {description.subline}</span>
            ) : null}
          </>
        ) : (
          <span className={textMuted}>
            {detection.busy
              ? "Detecting…"
              : detection.error
                ? `Detect failed — ${detection.error}`
                : "Chip not detected — click Detect to try again"}
          </span>
        )}
        {driver.transport === "serial" && (
          <button
            onClick={() => detection.detect()}
            disabled={!serialPort || detection.busy || inProgress}
            className="ml-auto flex items-center gap-1 text-xs px-2 py-0.5 rounded bg-violet-500/20 text-violet-300 hover:bg-violet-500/30 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Detect
          </button>
        )}
      </div>

      {/* Driver-specific options panel. Drivers with no options (e.g. DFU)
       *  return null, in which case we skip the row entirely. */}
      <OptionsPanel chip={chip?.raw as never} />

      {/* Operation-specific common controls. */}
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
              {imagePath ?? `Choose .${driver.imageExtensions.join(" / .")}`}
            </button>
          </Field>
          <Field label="Flash address">
            <TextInput
              value={isAddressEmbedded ? "(from image)" : address}
              onChange={setAddress}
              disabled={isAddressEmbedded}
              widthClass="w-32"
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
                onClick={startFlash}
                disabled={!handle || !imagePath || busy}
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
              {backupPath ?? `Choose .${driver.backupExtension}`}
            </button>
          </Field>
          <Field label="Offset">
            <TextInput value={backupOffset} onChange={setBackupOffset} widthClass="w-32" />
          </Field>
          <Field label="Size">
            {backupFullChip ? (
              <div className={`text-xs ${textMuted} px-2 py-1`}>
                Full chip
                {chip?.flashSizeKb ? ` (${chip.flashSizeKb} KB)` : ""}
              </div>
            ) : (
              <TextInput
                value={backupSize}
                onChange={setBackupSize}
                placeholder="0x10000"
                widthClass="w-32"
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
          {chip?.raw &&
            typeof chip.raw === "object" &&
            "rdp_level" in (chip.raw as Record<string, unknown>) &&
            String((chip.raw as { rdp_level?: string }).rdp_level ?? "")
              .toLowerCase()
              .includes("lock") ? (
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
                onClick={startBackup}
                disabled={!handle || !backupPath || busy}
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
                  onClick={startErase}
                  disabled={!handle || busy}
                >
                  <Trash2 size={12} /> Yes, erase
                </ActionButton>
              </>
            ) : (
              <ActionButton
                variant="danger"
                onClick={() => setEraseConfirm(true)}
                disabled={!handle || busy}
              >
                <Trash2 size={12} /> Erase entire flash
              </ActionButton>
            )}
          </div>
        </div>
      )}

      {(inProgress ||
        flash.phase === "done" ||
        flash.phase === "error" ||
        flash.phase === "cancelled") && (
        <div className={`px-3 py-2 ${borderDivider} border-b`}>
          <div className={`text-xs ${textSecondary} mb-1 capitalize`}>
            {phaseLabel}
            {flash.bytesTotal > 0 && (
              <>
                {" "}
                — {progressPct}% (
                {flash.bytesDone.toLocaleString("en-AU")}/
                {flash.bytesTotal.toLocaleString("en-AU")} bytes)
              </>
            )}
          </div>
          {flash.bytesTotal > 0 && (
            <div className="h-2 rounded bg-[var(--bg-primary)] overflow-hidden">
              <div
                className="h-full bg-sky-400 transition-all"
                style={{ width: `${progressPct}%` }}
              />
            </div>
          )}
          {flash.error && (
            <div className="text-xs text-[color:var(--text-danger)] mt-1">
              {flash.error}
            </div>
          )}
        </div>
      )}

      <div className="flex-1 overflow-y-auto p-3 font-mono text-xs">
        {flash.log.length === 0 ? (
          <div className={textMuted}>
            {operation === "flash"
              ? `Pick an image and click Flash to begin.${driver.transport === "serial" ? " The terminal will be disconnected for the duration of the flash." : ""}`
              : operation === "backup"
                ? "Choose an output file and click Read flash. Use Full chip to dump everything."
                : "Click Erase entire flash to wipe the chip. This is destructive."}
          </div>
        ) : (
          flash.log.map((line, i) => (
            <div key={i} className={textPrimary}>
              {line}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

interface EmptyStateProps {
  port: string | null;
  dfuDevice: DfuDeviceInfo | null;
  busy: boolean;
  error: string | null;
  onDetect: () => Promise<void>;
}

function EmptyState({
  port,
  dfuDevice,
  busy,
  error,
  onDetect,
}: EmptyStateProps) {
  // Manual-detect button only makes sense when we have a serial port — DFU
  // detection is implicit (just pick a device from the picker).
  const canDetect = !!port && !busy;
  const message = useMemo(() => {
    if (busy) return "Detecting chip…";
    if (error) return `Detect failed — ${error}`;
    if (!port && !dfuDevice) {
      return "Pick a serial port or a DFU device from the top bar to begin.";
    }
    if (port) {
      return "No supported chip detected on this port. Hold the chip in bootloader mode and click Detect.";
    }
    return "Selected DFU device isn't a recognised chip family.";
  }, [port, dfuDevice, busy, error]);

  // Track in-flight detect to flip the button label.
  const detectingRef = useRef(false);
  const handleClick = useCallback(async () => {
    if (detectingRef.current) return;
    detectingRef.current = true;
    try {
      await onDetect();
    } finally {
      detectingRef.current = false;
    }
  }, [onDetect]);

  return (
    <div className="flex-1 flex flex-col items-center justify-center gap-3 p-6">
      <Cpu size={28} className={textMuted} />
      <div className={`text-xs text-center max-w-md ${textSecondary}`}>
        {message}
      </div>
      {canDetect && (
        <button
          onClick={handleClick}
          className="flex items-center gap-1 text-xs px-3 py-1.5 rounded bg-violet-500/20 text-violet-300 hover:bg-violet-500/30"
        >
          Detect chip
        </button>
      )}
    </div>
  );
}
