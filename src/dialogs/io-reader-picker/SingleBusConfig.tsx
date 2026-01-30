// ui/src/dialogs/io-reader-picker/SingleBusConfig.tsx
//
// Status and bus configuration UI for single-bus devices (slcan, gs_usb, socketcan, serial).
// Shows device status (online/offline) and allows setting a bus number override.
// For serial devices, also shows framing configuration.

import { Loader2, AlertCircle, CheckCircle2, Bus, Layers } from "lucide-react";
import { iconMd, iconXs, flexRowGap2 } from "../../styles/spacing";
import { caption, sectionHeaderText } from "../../styles/typography";
import type { DeviceProbeResult, FramingEncoding } from "../../api/io";

/** Simplified framing config for per-interface display */
export interface InterfaceFramingConfig {
  /** Framing mode */
  encoding: FramingEncoding;
  /** Delimiter hex string for delimiter mode (e.g., "0D0A" for CRLF) */
  delimiterHex?: string;
  /** Max frame length for delimiter mode */
  maxFrameLength?: number;
  /** Whether to validate CRC-16 for Modbus RTU mode */
  validateCrc?: boolean;
  /** Also emit raw bytes in addition to frames */
  emitRawBytes?: boolean;
}

/** Framing mode options for dropdown */
const FRAMING_OPTIONS: { value: FramingEncoding; label: string }[] = [
  { value: "raw", label: "None (Raw)" },
  { value: "delimiter", label: "Delimiter" },
  { value: "slip", label: "SLIP" },
  { value: "modbus_rtu", label: "Modbus RTU" },
];

interface SingleBusConfigProps {
  /** Probe result (null while loading or before probe) */
  probeResult: DeviceProbeResult | null;
  /** Whether probe is in progress */
  isLoading: boolean;
  /** Error message from probe (null if success) */
  error: string | null;
  /** Current bus number override (undefined = use default 0) */
  busOverride?: number;
  /** Called when bus override changes */
  onBusOverrideChange: (bus: number | undefined) => void;
  /** Profile name for display */
  profileName?: string;
  /** Use compact inline styling (no header, reduced padding) */
  compact?: boolean;
  /** Bus numbers that are already used by other sources (for duplicate warning) */
  usedBuses?: Set<number>;
  /** Profile kind (e.g., "serial") - shows framing options for serial */
  profileKind?: string;
  /** Current framing config (for serial profiles) */
  framingConfig?: InterfaceFramingConfig;
  /** Called when framing config changes */
  onFramingChange?: (config: InterfaceFramingConfig) => void;
}

export default function SingleBusConfig({
  probeResult,
  isLoading,
  error,
  busOverride,
  onBusOverrideChange,
  profileName,
  compact = false,
  usedBuses,
  profileKind,
  framingConfig,
  onFramingChange,
}: SingleBusConfigProps) {
  const effectiveBus = busOverride ?? 0;
  const isDuplicate = usedBuses && usedBuses.has(effectiveBus);
  const isSerial = profileKind === "serial";
  const effectiveFraming = framingConfig?.encoding ?? "raw";

  // Compact wrapper for inline display
  const wrapperClass = compact
    ? "ml-7 mt-1 mb-2 pl-3 border-l-2 border-[color:var(--text-cyan)]"
    : "border-t border-[color:var(--border-default)] px-4 py-3";

  // Loading state
  if (isLoading) {
    return (
      <div className={wrapperClass}>
        <div className={`flex items-center gap-2 ${caption}`}>
          <Loader2 className={`${iconXs} animate-spin`} />
          <span>Probing{profileName ? ` ${profileName}` : ""}...</span>
        </div>
      </div>
    );
  }

  // Error state (probe failed)
  if (error || (probeResult && !probeResult.success)) {
    const errorMsg = error || probeResult?.error || "Device not responding";
    return (
      <div className={wrapperClass}>
        <div className="flex items-center gap-2 text-xs text-[color:var(--status-danger-text)]">
          <AlertCircle className={`${iconXs} flex-shrink-0`} />
          <span className="truncate">{errorMsg}</span>
        </div>
      </div>
    );
  }

  // No result yet - show loading (probe should start shortly)
  if (!probeResult) {
    return (
      <div className={wrapperClass}>
        <div className={`flex items-center gap-2 ${caption}`}>
          <Loader2 className={`${iconXs} animate-spin`} />
          <span>Probing{profileName ? ` ${profileName}` : ""}...</span>
        </div>
      </div>
    );
  }

  // Success state - show status and bus selector
  if (compact) {
    const showDelimiterOptions = isSerial && effectiveFraming === "delimiter";
    const showModbusOptions = isSerial && effectiveFraming === "modbus_rtu";
    const showRawBytesOption = isSerial && effectiveFraming !== "raw";

    return (
      <div className={wrapperClass}>
        <div className="flex items-center gap-2 text-xs">
          <CheckCircle2 className={`${iconXs} text-green-500 flex-shrink-0`} />
          <span className="text-[color:var(--text-secondary)]">
            {probeResult.primaryInfo || "Online"}
          </span>
          {probeResult.secondaryInfo && (
            <span className="text-[color:var(--text-muted)]">
              ({probeResult.secondaryInfo})
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 mt-1 text-xs">
          <Bus className={`${iconXs} text-slate-400 flex-shrink-0`} />
          <span className="text-[color:var(--text-muted)]">Bus:</span>
          <select
            value={effectiveBus}
            onChange={(e) => {
              const val = parseInt(e.target.value, 10);
              onBusOverrideChange(val === 0 ? undefined : val);
            }}
            className={`px-1 py-0.5 rounded border text-xs ${
              isDuplicate
                ? "border-[color:var(--text-amber)] bg-[var(--status-warning-bg)] text-[color:var(--text-amber)]"
                : "border-[color:var(--border-default)] bg-[var(--bg-primary)] text-[color:var(--text-secondary)]"
            } focus:ring-1 focus:ring-cyan-500`}
          >
            {Array.from({ length: 8 }, (_, i) => (
              <option key={i} value={i}>
                Bus {i}
              </option>
            ))}
          </select>
          {isDuplicate && (
            <span className="text-amber-500" title="Another source uses this bus number">⚠</span>
          )}

          {/* Framing selector for serial devices */}
          {isSerial && onFramingChange && (
            <>
              <span className="text-[color:var(--text-muted)]">|</span>
              <Layers className={`${iconXs} text-slate-400 flex-shrink-0`} />
              <select
                value={effectiveFraming}
                onChange={(e) => {
                  onFramingChange({ ...framingConfig, encoding: e.target.value as FramingEncoding });
                }}
                className="px-1 py-0.5 rounded border text-xs border-[color:var(--border-default)] bg-[var(--bg-primary)] text-[color:var(--text-secondary)] focus:ring-1 focus:ring-cyan-500"
              >
                {FRAMING_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </>
          )}
        </div>

        {/* Framing sub-options */}
        {isSerial && onFramingChange && (showDelimiterOptions || showModbusOptions || showRawBytesOption) && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-1.5 text-xs text-[color:var(--text-secondary)]">
            {/* Delimiter options */}
            {showDelimiterOptions && (
              <>
                <label className="flex items-center gap-1">
                  <span>Delimiter:</span>
                  <input
                    type="text"
                    value={framingConfig?.delimiterHex ?? "0A"}
                    onChange={(e) => onFramingChange({ ...framingConfig, encoding: effectiveFraming, delimiterHex: e.target.value })}
                    placeholder="0A"
                    className="w-12 px-1 py-0.5 rounded border text-xs border-[color:var(--border-default)] bg-[var(--bg-primary)] text-[color:var(--text-secondary)] focus:ring-1 focus:ring-cyan-500 font-mono"
                  />
                </label>
                <label className="flex items-center gap-1">
                  <span>Max:</span>
                  <input
                    type="number"
                    value={framingConfig?.maxFrameLength ?? 1024}
                    onChange={(e) => onFramingChange({ ...framingConfig, encoding: effectiveFraming, maxFrameLength: parseInt(e.target.value, 10) || 1024 })}
                    className="w-16 px-1 py-0.5 rounded border text-xs border-[color:var(--border-default)] bg-[var(--bg-primary)] text-[color:var(--text-secondary)] focus:ring-1 focus:ring-cyan-500"
                  />
                </label>
              </>
            )}

            {/* Modbus RTU options */}
            {showModbusOptions && (
              <label className="flex items-center gap-1 cursor-pointer">
                <input
                  type="checkbox"
                  checked={framingConfig?.validateCrc ?? true}
                  onChange={(e) => onFramingChange({ ...framingConfig, encoding: effectiveFraming, validateCrc: e.target.checked })}
                  className="w-3 h-3 rounded border-[color:var(--border-default)] text-cyan-500 focus:ring-cyan-500"
                />
                <span>Validate CRC-16</span>
              </label>
            )}

            {/* Raw bytes option (for any framing mode except raw) */}
            {showRawBytesOption && (
              <label className="flex items-center gap-1 cursor-pointer">
                <input
                  type="checkbox"
                  checked={framingConfig?.emitRawBytes ?? false}
                  onChange={(e) => onFramingChange({ ...framingConfig, encoding: effectiveFraming, emitRawBytes: e.target.checked })}
                  className="w-3 h-3 rounded border-[color:var(--border-default)] text-cyan-500 focus:ring-cyan-500"
                />
                <span>Capture raw bytes</span>
              </label>
            )}
          </div>
        )}
      </div>
    );
  }

  // Full mode - separate section display
  const showDelimiterOptionsFull = isSerial && effectiveFraming === "delimiter";
  const showModbusOptionsFull = isSerial && effectiveFraming === "modbus_rtu";
  const showRawBytesOptionFull = isSerial && effectiveFraming !== "raw";

  return (
    <div className="border-t border-[color:var(--border-default)] px-4 py-3">
      <div className="flex items-center justify-between">
        <div className={flexRowGap2}>
          <CheckCircle2 className={`${iconMd} text-green-500`} />
          <span className={sectionHeaderText}>
            {probeResult.primaryInfo || "Device Online"}
          </span>
          {probeResult.secondaryInfo && (
            <span className={caption}>
              ({probeResult.secondaryInfo})
            </span>
          )}
        </div>
      </div>

      <div className="flex items-center gap-2 mt-2 text-sm">
        <Bus className={`${iconMd} text-slate-400`} />
        <span className="text-[color:var(--text-secondary)]">Output Bus:</span>
        <select
          value={effectiveBus}
          onChange={(e) => {
            const val = parseInt(e.target.value, 10);
            onBusOverrideChange(val === 0 ? undefined : val);
          }}
          className={`px-2 py-1 rounded border text-sm ${
            isDuplicate
              ? "border-[color:var(--text-amber)] bg-[var(--status-warning-bg)] text-[color:var(--text-amber)]"
              : "border-[color:var(--border-default)] bg-[var(--bg-primary)] text-[color:var(--text-secondary)]"
          } focus:ring-1 focus:ring-cyan-500`}
        >
          {Array.from({ length: 8 }, (_, i) => (
            <option key={i} value={i}>
              Bus {i}
            </option>
          ))}
        </select>
        {isDuplicate && (
          <span className="text-amber-500 text-sm" title="Another source uses this bus number">
            ⚠ Duplicate
          </span>
        )}
      </div>

      {/* Framing selector for serial devices */}
      {isSerial && onFramingChange && (
        <>
          <div className="flex items-center gap-2 mt-2 text-sm">
            <Layers className={`${iconMd} text-slate-400`} />
            <span className="text-[color:var(--text-secondary)]">Framing:</span>
            <select
              value={effectiveFraming}
              onChange={(e) => {
                onFramingChange({ ...framingConfig, encoding: e.target.value as FramingEncoding });
              }}
              className="px-2 py-1 rounded border text-sm border-[color:var(--border-default)] bg-[var(--bg-primary)] text-[color:var(--text-secondary)] focus:ring-1 focus:ring-cyan-500"
            >
              {FRAMING_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>

          {/* Framing sub-options */}
          {(showDelimiterOptionsFull || showModbusOptionsFull || showRawBytesOptionFull) && (
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2 mt-2 ml-6 text-sm text-[color:var(--text-secondary)]">
              {/* Delimiter options */}
              {showDelimiterOptionsFull && (
                <>
                  <label className="flex items-center gap-1.5">
                    <span>Delimiter (hex):</span>
                    <input
                      type="text"
                      value={framingConfig?.delimiterHex ?? "0A"}
                      onChange={(e) => onFramingChange({ ...framingConfig, encoding: effectiveFraming, delimiterHex: e.target.value })}
                      placeholder="0A"
                      className="w-16 px-2 py-1 rounded border text-sm border-[color:var(--border-default)] bg-[var(--bg-primary)] text-[color:var(--text-secondary)] focus:ring-1 focus:ring-cyan-500 font-mono"
                    />
                  </label>
                  <label className="flex items-center gap-1.5">
                    <span>Max length:</span>
                    <input
                      type="number"
                      value={framingConfig?.maxFrameLength ?? 1024}
                      onChange={(e) => onFramingChange({ ...framingConfig, encoding: effectiveFraming, maxFrameLength: parseInt(e.target.value, 10) || 1024 })}
                      className="w-20 px-2 py-1 rounded border text-sm border-[color:var(--border-default)] bg-[var(--bg-primary)] text-[color:var(--text-secondary)] focus:ring-1 focus:ring-cyan-500"
                    />
                  </label>
                </>
              )}

              {/* Modbus RTU options */}
              {showModbusOptionsFull && (
                <label className="flex items-center gap-1.5 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={framingConfig?.validateCrc ?? true}
                    onChange={(e) => onFramingChange({ ...framingConfig, encoding: effectiveFraming, validateCrc: e.target.checked })}
                    className="w-4 h-4 rounded border-[color:var(--border-default)] text-cyan-500 focus:ring-cyan-500"
                  />
                  <span>Validate CRC-16</span>
                </label>
              )}

              {/* Raw bytes option (for any framing mode except raw) */}
              {showRawBytesOptionFull && (
                <label className="flex items-center gap-1.5 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={framingConfig?.emitRawBytes ?? false}
                    onChange={(e) => onFramingChange({ ...framingConfig, encoding: effectiveFraming, emitRawBytes: e.target.checked })}
                    className="w-4 h-4 rounded border-[color:var(--border-default)] text-cyan-500 focus:ring-cyan-500"
                  />
                  <span>Capture raw bytes</span>
                </label>
              )}
            </div>
          )}
        </>
      )}

      <p className={`${caption} mt-2`}>
        {isSerial
          ? "Configure bus number and framing for this serial device."
          : "Frames from this device will be tagged with the selected bus number."}
      </p>
    </div>
  );
}
