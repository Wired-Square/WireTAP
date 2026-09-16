// ui/src/apps/devices/tabs/FirmwareTab.tsx
//
// Firmware upgrade tab — driven entirely by the OtaEvent push stream.
// No client-side wizard state: events arrive and are appended to a log;
// terminator events (Complete / Cancelled / Error) flip `running` to false.

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { FolderOpen, HardDriveUpload, ListChecks, XCircle } from "lucide-react";
import {
  alertDanger,
  cardDefault,
  labelSimple,
  primaryButtonBase,
  selectSimple,
  stopButtonBase,
  textDanger,
  textPrimary,
  textSecondary,
} from "../../../styles";
import {
  listImages,
  otaCancel,
  otaStart,
  subscribeOtaEvents,
  type ImageSlotInfo,
  type OtaEvent,
  type Transport,
} from "../../../api/smpUpgrade";
import { pickFileToOpen } from "../../../api/dialogs";

const TERMINATOR_TYPES = new Set(["Complete", "Cancelled", "Error"]);
const EVENT_LOG_MAX = 200;
const HASH_PREFIX_CHARS = 12;

function renderEvent(ev: OtaEvent, t: TFunction): string {
  switch (ev.type) {
    case "SessionOpened":   return t("firmware.ota.sessionOpened");
    case "UploadProgress":  return t("firmware.ota.uploadProgress", {
      percent: ev.percent.toFixed(1),
      bytesSent: ev.bytes_sent,
      totalBytes: ev.total_bytes,
    });
    case "Activating":      return t("firmware.ota.activating");
    case "Activated":       return t("firmware.ota.activated", { hash: ev.hash.slice(0, HASH_PREFIX_CHARS) });
    case "Resetting":       return t("firmware.ota.resetting");
    case "ResetSent":       return t("firmware.ota.resetSent");
    case "Reconnecting":    return t("firmware.ota.reconnecting", { name: ev.name });
    case "Reconnected":     return t("firmware.ota.reconnected", { deviceId: ev.device_id });
    case "Verified":        return t("firmware.ota.verified", { hash: ev.active_hash.slice(0, HASH_PREFIX_CHARS) });
    case "Confirming":      return t("firmware.ota.confirming");
    case "Confirmed":       return t("firmware.ota.confirmed");
    case "Cancelled":       return t("firmware.ota.cancelled");
    case "Complete":        return t("firmware.ota.complete");
    case "Error":           return t("firmware.ota.error", { message: ev.message });
  }
}

type UploadProgressEvent = Extract<OtaEvent, { type: "UploadProgress" }>;

function UploadProgressBar({
  progress,
  startedAt,
}: {
  progress: UploadProgressEvent;
  startedAt: number;
}) {
  const { t } = useTranslation("devices");
  const elapsedSec = Math.max(0.001, (Date.now() - startedAt) / 1000);
  const kbps = progress.bytes_sent / 1024 / elapsedSec;
  const remaining = Math.max(0, progress.total_bytes - progress.bytes_sent);
  const etaSec = kbps > 0 ? remaining / 1024 / kbps : Infinity;
  const pct = Math.min(100, Math.max(0, progress.percent));
  // Width of the byte counts is determined by the total — pad sent to
  // match so the layout doesn't reflow chunk-by-chunk. Percentage is
  // padded to "100.0" width (5 chars) for the same reason.
  const totalKBStr = Math.round(progress.total_bytes / 1024).toString();
  const sentKBStr = Math.round(progress.bytes_sent / 1024).toString().padStart(totalKBStr.length, " ");
  const pctStr = pct.toFixed(1).padStart(5, " ");
  const kbpsStr = kbps.toFixed(1).padStart(5, " ");
  const etaText = !isFinite(etaSec) || etaSec < 0
    ? t("firmware.eta.unknown")
    : etaSec < 60
      ? t("firmware.eta.seconds", { seconds: Math.round(etaSec) })
      : t("firmware.eta.minutes", {
          minutes: Math.floor(etaSec / 60),
          seconds: Math.round(etaSec % 60),
        });
  return (
    <div className={`${cardDefault} p-3 flex flex-col gap-2`}>
      <div className="flex items-center justify-between text-xs font-mono whitespace-pre">
        <span className={`font-medium ${textPrimary}`}>
          {pctStr}% — {sentKBStr} / {totalKBStr} KB
        </span>
        <span className={textSecondary}>
          {kbpsStr} kB/s · ETA {etaText}
        </span>
      </div>
      <div className="h-2 w-full bg-[var(--bg-tertiary)] rounded overflow-hidden">
        <div
          className="h-full bg-[var(--accent-primary)] transition-[width] duration-150"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

function SlotBadge({ label, active = true }: { label: string; active?: boolean }) {
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

export interface Props {
  deviceId: string;
  availableTransports: Transport[];
}

export default function FirmwareTab({ deviceId, availableTransports }: Props) {
  const { t } = useTranslation("devices");
  const [transport, setTransport] = useState<Transport>(
    availableTransports[0] ?? "ble",
  );
  const [filePath, setFilePath] = useState<string | null>(null);
  const fileName = filePath ? (filePath.split(/[\\/]/).pop() ?? filePath) : null;
  const [slots, setSlots] = useState<ImageSlotInfo[] | null>(null);
  const [events, setEvents] = useState<OtaEvent[]>([]);
  const [progressState, setProgressState] = useState<{
    latest: UploadProgressEvent | null;
    startedAt: number | null;
  }>({ latest: null, startedAt: null });
  const [running, setRunning] = useState(false);
  const [listError, setListError] = useState<string | null>(null);

  const logRef = useRef<HTMLUListElement>(null);

  useEffect(() => {
    return subscribeOtaEvents((ev) => {
      if (ev.type === "UploadProgress") {
        // Stamp startedAt on the first progress event (not on click —
        // the click-to-first-byte gap includes session open and
        // slot-erase, neither of which is part of the upload itself).
        setProgressState((prev) => ({
          latest: ev,
          startedAt: prev.startedAt ?? Date.now(),
        }));
      } else {
        setEvents((prev) => {
          const next = prev.length < EVENT_LOG_MAX ? [...prev, ev] : [...prev.slice(1), ev];
          return next;
        });
        if (TERMINATOR_TYPES.has(ev.type)) {
          setRunning(false);
        }
      }
    });
  }, []);

  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [events]);

  async function handlePickFile() {
    try {
      const result = await pickFileToOpen({
        filters: [{ name: t("firmware.dialogFilterName"), extensions: ["bin"] }],
      });
      if (result) {
        setFilePath(result);
      }
    } catch (e) {
      setEvents((prev) => [...prev, { type: "Error", message: String(e) }]);
    }
  }

  async function handleStart() {
    if (!filePath) return;
    setEvents([]);
    setProgressState({ latest: null, startedAt: null });
    setRunning(true);
    try {
      await otaStart({ deviceId, transport, filePath });
    } catch (e) {
      setEvents((prev) => [...prev, { type: "Error", message: String(e) }]);
      setRunning(false);
    }
  }

  async function handleCancel() {
    try {
      await otaCancel();
    } catch (e) {
      setEvents((prev) => [...prev, { type: "Error", message: String(e) }]);
    }
  }

  async function handleListImages() {
    setListError(null);
    try {
      const result = await listImages(deviceId, transport);
      setSlots(result);
    } catch (e) {
      setListError(String(e));
      setSlots(null);
    }
  }

  return (
    <div className="flex flex-col gap-4 p-4 h-full overflow-y-auto">

      {/* Controls */}
      <div className={`${cardDefault} p-4 flex flex-col gap-3`}>

        {/* File picker */}
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={handlePickFile}
            disabled={running}
            className={`${primaryButtonBase} text-sm px-4 py-2 min-w-[160px] justify-center`}
          >
            <FolderOpen className="w-4 h-4" />
            {t("firmware.choose")}
          </button>
          {fileName ? (
            <span className={`text-sm ${textPrimary} truncate`}>{fileName}</span>
          ) : (
            <span className={`text-sm ${textSecondary}`}>{t("firmware.noFileSelected")}</span>
          )}
        </div>

        {/* Transport selector — only when more than one available */}
        {availableTransports.length > 1 && (
          <div className="flex items-center gap-2">
            <label className={`text-sm ${labelSimple}`}>{t("firmware.transport")}</label>
            <select
              value={transport}
              onChange={(e) => setTransport(e.target.value as Transport)}
              disabled={running}
              className={`${selectSimple} w-32 py-1 px-2 text-sm`}
            >
              {availableTransports.map((t) => (
                <option key={t} value={t}>{t === "ble" ? "BLE" : "UDP"}</option>
              ))}
            </select>
          </div>
        )}

        {/* Action buttons */}
        <div className="flex items-center gap-2 pt-1">
          {running ? (
            <button
              type="button"
              onClick={handleCancel}
              className={`${stopButtonBase} text-sm px-4 py-2 min-w-[160px] justify-center`}
            >
              <XCircle className="w-4 h-4" />
              {t("firmware.cancel")}
            </button>
          ) : (
            <button
              type="button"
              onClick={handleStart}
              disabled={!filePath}
              className={`${primaryButtonBase} text-sm px-4 py-2 min-w-[160px] justify-center`}
            >
              <HardDriveUpload className="w-4 h-4" />
              {t("firmware.flash")}
            </button>
          )}
          <button
            type="button"
            onClick={handleListImages}
            disabled={running}
            className={`${primaryButtonBase} text-sm px-4 py-2 min-w-[160px] justify-center`}
          >
            <ListChecks className="w-4 h-4" />
            {t("firmware.listImages")}
          </button>
        </div>
      </div>

      {/* Slot cards */}
      {listError && (
        <div className={`${alertDanger} ${textDanger} text-sm`}>{listError}</div>
      )}
      {slots !== null && slots.length > 0 && (
        <div className="flex flex-col gap-2">
          {slots.map((img, idx) => (
            <div key={idx} className={`${cardDefault} p-3`}>
              <div className="flex items-center justify-between mb-2">
                <span className={`text-sm font-medium ${textPrimary}`}>
                  {img.image !== null
                    ? t("firmware.slot.labelWithImage", { slot: img.slot, image: img.image })
                    : t("firmware.slot.label", { slot: img.slot })}
                </span>
                <div className="flex gap-1">
                  {img.active    && <SlotBadge label={t("inspect.active")} />}
                  {img.confirmed && <SlotBadge label={t("inspect.confirmed")} />}
                  {img.pending   && <SlotBadge label={t("inspect.pending")} />}
                  {img.bootable  && <SlotBadge label={t("inspect.bootable")} active={false} />}
                  {img.permanent && <SlotBadge label={t("inspect.permanent")} active={false} />}
                </div>
              </div>
              <div className={`text-xs ${textSecondary} space-y-0.5`}>
                <div>
                  {t("firmware.slot.version")}{" "}
                  <span className={`font-mono ${textPrimary}`}>{img.version || t("firmware.eta.unknown")}</span>
                </div>
                <div className="font-mono">
                  <span className="font-sans">{t("firmware.slot.hash")}</span>{" "}
                  <span className={`${textPrimary} break-all`}>{img.hash || t("firmware.eta.unknown")}</span>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
      {slots !== null && slots.length === 0 && (
        <div className={`text-sm ${textSecondary} text-center py-4`}>
          {t("firmware.noSlotsReported")}
        </div>
      )}

      {progressState.latest && progressState.startedAt !== null && (
        <UploadProgressBar progress={progressState.latest} startedAt={progressState.startedAt} />
      )}

      {/* Event log — always shown */}
      <div className={`${cardDefault} p-3 flex flex-col gap-1`}>
        <div className={`text-xs font-medium ${textSecondary} uppercase tracking-wide mb-1`}>
          {t("firmware.ota.logTitle")}
        </div>
        {events.length === 0 ? (
          <div className={`text-xs ${textSecondary}`}>{t("firmware.ota.empty")}</div>
        ) : (
          <ul
            ref={logRef}
            className="max-h-48 overflow-y-auto space-y-0.5 font-mono text-xs"
          >
            {events.map((ev, i) => {
              // UploadProgress events are filtered into the bar above.
              if (ev.type === "UploadProgress") return null;
              const isError = ev.type === "Error" || ev.type === "Cancelled";
              const isDone  = ev.type === "Complete";
              return (
                <li
                  key={i}
                  className={
                    isError ? textDanger
                    : isDone ? "text-green-500"
                    : textSecondary
                  }
                >
                  {renderEvent(ev, t)}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
