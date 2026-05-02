// src/components/SerialPortPicker.tsx
//
// Shared serial-port picker for apps that consume a UART (e.g. the Serial
// terminal). Parallel to FrameLinkDevicePicker but for raw serial ports:
// renders a compact button showing the active port + a status dot, opens a
// popover listing every detected serial port with the matching saved
// `kind: "serial"` IO profile (if any) surfaced as a chip.
//
// The popover also exposes baud / data bits / stop bits / parity controls
// so the user can override saved profile defaults before connecting. The
// picker itself is pure — pass enumerated ports + a connect callback in.

import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Bluetooth, CircleDot, HardDrive, RefreshCcw, Usb } from "lucide-react";
import { buttonBase } from "../styles/buttonStyles";
import {
  bgPrimary,
  bgSurface,
  borderDefault,
  borderDivider,
  textPrimary,
  textSecondary,
  textMuted,
} from "../styles/colourTokens";
import type { SerialPortInfo } from "../api/serial";
import type { IOProfile } from "../hooks/useSettings";

export type Parity = "none" | "odd" | "even";

export interface SerialPortSettings {
  baudRate: number;
  dataBits: 5 | 6 | 7 | 8;
  stopBits: 1 | 2;
  parity: Parity;
}

export interface AnnotatedSerialPort {
  info: SerialPortInfo;
  /** Matching saved serial profile, if one points at this port. */
  profile: Extract<IOProfile, { kind: "serial" }> | null;
}

export interface SerialPortPickerProps {
  /** Enumerated serial ports with their saved-profile annotations. */
  ports: AnnotatedSerialPort[];
  /** Currently active port (selected and being connected to). */
  activePort: string | null;
  /** True when the active port has a live session. */
  isConnected: boolean;
  /** Current framing settings (mirrored back via onSettingsChange). */
  settings: SerialPortSettings;
  loading?: boolean;
  error?: string | null;
  /** True while a connect is in flight. */
  connecting?: boolean;

  onRefresh: () => void;
  /** Called when the user picks a port row in the popover. Pre-fills framing
   *  from the matching profile if one exists. */
  onSelectPort: (port: string, matchedProfileName: string | null) => void;
  onSettingsChange: (patch: Partial<SerialPortSettings>) => void;
  /** Called when the user clicks Connect — passes the matched profile id (if any). */
  onConnect: (existingProfileId?: string) => void;
  onDisconnect: () => void;
}

const COMMON_BAUDS = [
  9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600, 1500000, 3000000,
];

function portIcon(portType: string) {
  const lc = portType.toLowerCase();
  if (lc.includes("usb")) return Usb;
  if (lc.includes("bluetooth")) return Bluetooth;
  if (lc.includes("pci")) return HardDrive;
  return CircleDot;
}

function dotClass(state: "connected" | "connecting" | "selected" | "idle"): string {
  switch (state) {
    case "connected":
      return "bg-[var(--status-success-text)]";
    case "connecting":
      return "bg-[var(--status-info-text)] animate-pulse";
    case "selected":
      return "bg-[var(--status-info-text)]";
    case "idle":
    default:
      return "bg-[color:var(--text-muted)]";
  }
}

export default function SerialPortPicker({
  ports,
  activePort,
  isConnected,
  settings,
  loading = false,
  error = null,
  connecting = false,
  onRefresh,
  onSelectPort,
  onSettingsChange,
  onConnect,
  onDisconnect,
}: SerialPortPickerProps) {
  const { t } = useTranslation("common");
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const matchedRow = useMemo(
    () => ports.find((p) => p.info.port_name === activePort) ?? null,
    [ports, activePort],
  );

  // Close on outside click.
  useEffect(() => {
    if (!isOpen) return;
    function handleMouseDown(e: MouseEvent) {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        setIsOpen(false);
      }
    }
    document.addEventListener("mousedown", handleMouseDown);
    return () => document.removeEventListener("mousedown", handleMouseDown);
  }, [isOpen]);

  // Close on Escape.
  useEffect(() => {
    if (!isOpen) return;
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") setIsOpen(false);
    }
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [isOpen]);

  // Refresh ports each time the popover opens — devices come and go.
  useEffect(() => {
    if (isOpen) onRefresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  const buttonState = isConnected
    ? "connected"
    : connecting
      ? "connecting"
      : activePort
        ? "selected"
        : "idle";

  const buttonLabel = activePort
    ? `${activePort} @ ${settings.baudRate}`
    : t("serialPortPicker.buttonChoose");

  return (
    <div ref={containerRef} className="relative shrink-0">
      <button
        type="button"
        className={buttonBase}
        onClick={() => setIsOpen((v) => !v)}
        title={activePort ? activePort : t("serialPortPicker.buttonTitle")}
      >
        <span
          className={`w-2 h-2 rounded-full flex-shrink-0 ${dotClass(buttonState)}`}
          aria-hidden
        />
        <span className="max-w-56 truncate">{buttonLabel}</span>
      </button>

      {isOpen && (
        <div
          className={`absolute left-0 top-full mt-1 z-50 w-[420px] rounded-lg border ${borderDefault} ${bgSurface} shadow-xl flex flex-col`}
          role="dialog"
        >
          {/* Header */}
          <div
            className={`flex items-center justify-between px-3 py-2 ${borderDivider} border-b`}
          >
            <span className={`text-xs font-medium ${textSecondary}`}>
              {t("serialPortPicker.headerTitle", { count: ports.length })}
            </span>
            <button
              onClick={onRefresh}
              disabled={loading}
              className={`flex items-center gap-1 text-xs px-2 py-1 rounded hover:bg-[var(--hover-bg)] ${textSecondary}`}
              title={t("serialPortPicker.refreshTooltip")}
            >
              <RefreshCcw size={12} className={loading ? "animate-spin" : ""} />
              {t("serialPortPicker.refresh")}
            </button>
          </div>

          {/* Port list */}
          <div className="max-h-64 overflow-y-auto">
            {error && (
              <div className="p-3 text-xs text-[color:var(--text-danger)]">
                {error}
              </div>
            )}
            {!error && ports.length === 0 && !loading && (
              <div className={`p-4 text-xs ${textMuted}`}>
                {t("serialPortPicker.empty")}
              </div>
            )}
            <ul role="listbox">
              {ports.map((p) => {
                const Icon = portIcon(p.info.port_type);
                const selected = p.info.port_name === activePort;
                const label = [p.info.manufacturer, p.info.product]
                  .filter(Boolean)
                  .join(" — ");
                return (
                  <li key={p.info.port_name}>
                    <button
                      type="button"
                      role="option"
                      aria-selected={selected}
                      onClick={() =>
                        onSelectPort(p.info.port_name, p.profile?.name ?? null)
                      }
                      className={`w-full flex items-center gap-2 px-3 py-2 text-left text-xs border-b ${borderDivider} ${
                        selected ? "bg-sky-500/10" : "hover:bg-[var(--hover-bg)]"
                      }`}
                    >
                      <Icon size={14} className={textMuted} />
                      <div className="flex-1 min-w-0">
                        <div className={`font-mono ${textPrimary} truncate`}>
                          {p.info.port_name}
                        </div>
                        {label && (
                          <div className={`${textMuted} truncate`}>{label}</div>
                        )}
                      </div>
                      {p.profile && (
                        <span className="px-2 py-0.5 rounded text-[10px] font-medium bg-sky-500/20 text-sky-300">
                          {p.profile.name} · {p.profile.connection.baud_rate ?? "?"}
                        </span>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>

          {/* Settings */}
          <div
            className={`flex flex-wrap items-end gap-2 px-3 py-3 ${borderDivider} border-t`}
          >
            <Field label={t("serialPortPicker.fields.baud")}>
              <select
                className={`${bgPrimary} ${textPrimary} text-xs px-2 py-1 rounded border ${borderDivider}`}
                value={settings.baudRate}
                onChange={(e) =>
                  onSettingsChange({ baudRate: Number(e.target.value) || 115200 })
                }
                disabled={isConnected}
              >
                {COMMON_BAUDS.map((b) => (
                  <option key={b} value={b}>
                    {b}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={t("serialPortPicker.fields.data")}>
              <select
                className={`${bgPrimary} ${textPrimary} text-xs px-2 py-1 rounded border ${borderDivider}`}
                value={settings.dataBits}
                onChange={(e) =>
                  onSettingsChange({
                    dataBits: Number(e.target.value) as 5 | 6 | 7 | 8,
                  })
                }
                disabled={isConnected}
              >
                {[5, 6, 7, 8].map((v) => (
                  <option key={v} value={v}>
                    {v}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={t("serialPortPicker.fields.stop")}>
              <select
                className={`${bgPrimary} ${textPrimary} text-xs px-2 py-1 rounded border ${borderDivider}`}
                value={settings.stopBits}
                onChange={(e) =>
                  onSettingsChange({
                    stopBits: Number(e.target.value) as 1 | 2,
                  })
                }
                disabled={isConnected}
              >
                {[1, 2].map((v) => (
                  <option key={v} value={v}>
                    {v}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={t("serialPortPicker.fields.parity")}>
              <select
                className={`${bgPrimary} ${textPrimary} text-xs px-2 py-1 rounded border ${borderDivider}`}
                value={settings.parity}
                onChange={(e) =>
                  onSettingsChange({ parity: e.target.value as Parity })
                }
                disabled={isConnected}
              >
                <option value="none">{t("serialPortPicker.parity.none")}</option>
                <option value="odd">{t("serialPortPicker.parity.odd")}</option>
                <option value="even">{t("serialPortPicker.parity.even")}</option>
              </select>
            </Field>
            <div className="ml-auto flex items-center">
              {isConnected ? (
                <button
                  onClick={() => {
                    onDisconnect();
                    setIsOpen(false);
                  }}
                  className="text-xs px-3 py-1.5 rounded bg-red-500/20 text-red-300 hover:bg-red-500/30"
                >
                  {t("serialPortPicker.disconnect")}
                </button>
              ) : (
                <button
                  onClick={() => {
                    onConnect(matchedRow?.profile?.id);
                    setIsOpen(false);
                  }}
                  disabled={!activePort || connecting}
                  className="text-xs px-3 py-1.5 rounded bg-sky-500/20 text-sky-300 hover:bg-sky-500/30 disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  {connecting
                    ? t("serialPortPicker.connecting")
                    : t("serialPortPicker.connect")}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[10px] uppercase tracking-wide text-[color:var(--text-muted)]">
        {label}
      </span>
      {children}
    </label>
  );
}
