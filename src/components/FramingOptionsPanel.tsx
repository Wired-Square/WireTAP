// ui/src/components/FramingOptionsPanel.tsx
//
// Shared framing options panel used by:
// - IoReaderPickerDialog (for capture-time framing)
// - FramingModeDialog (for post-capture framing)
//
// Supports two styling variants:
// - "panel": Compact inline style for dialogs/panels
// - "card": Full card buttons with descriptions

import { useState, useEffect } from "react";
import { hexToBytes, bytesToHex } from "../utils/byteUtils";
import { toggleCardClass, toggleChipClass, bgDataInput, borderDataView, textDataSecondary, caption, captionMuted, bgSurface } from "../styles";

// Re-export for backwards compatibility (used by other components)
export { hexToBytes, bytesToHex };

/** Framing mode/encoding type */
export type FramingMode = "raw" | "slip" | "delimiter" | "modbus_rtu";

/** Framing configuration */
export interface FramingPanelConfig {
  /** Framing mode */
  mode: FramingMode;
  /** Delimiter bytes as hex string (e.g., "0A" or "0D0A") */
  delimiterHex?: string;
  /** Maximum frame length for delimiter-based framing */
  maxFrameLength?: number;
  /** Validate CRC for Modbus RTU */
  validateCrc?: boolean;
  /** Also emit raw bytes (for capture mode) */
  emitRawBytes?: boolean;
}

interface Props {
  /** Current framing configuration (null = no framing / raw mode) */
  config: FramingPanelConfig | null;
  /** Called when configuration changes */
  onChange: (config: FramingPanelConfig | null) => void;
  /** Visual variant */
  variant?: "panel" | "card";
  /** Show "Also capture raw bytes" toggle (for capture mode) */
  showEmitRawBytes?: boolean;
  /** Whether the component is disabled */
  disabled?: boolean;
}

export default function FramingOptionsPanel({
  config,
  onChange,
  variant = "panel",
  showEmitRawBytes = false,
  disabled = false,
}: Props) {
  const [delimiterHex, setDelimiterHex] = useState(config?.delimiterHex || "0A");
  const [maxLength, setMaxLength] = useState(config?.maxFrameLength || 256);

  // Sync local state when config changes externally
  useEffect(() => {
    if (config?.mode === "delimiter") {
      if (config.delimiterHex) {
        setDelimiterHex(config.delimiterHex);
      }
      if (config.maxFrameLength) {
        setMaxLength(config.maxFrameLength);
      }
    }
  }, [config]);

  const currentMode: FramingMode = config?.mode || "raw";
  const emitRawBytes = config?.emitRawBytes ?? true;
  const validateCrc = config?.validateCrc ?? true;

  const handleModeChange = (mode: FramingMode) => {
    if (mode === "raw") {
      onChange(null);
    } else {
      const newConfig: FramingPanelConfig = {
        mode,
        emitRawBytes: showEmitRawBytes ? emitRawBytes : undefined,
      };
      if (mode === "delimiter") {
        newConfig.delimiterHex = delimiterHex;
        newConfig.maxFrameLength = maxLength;
      }
      if (mode === "modbus_rtu") {
        newConfig.validateCrc = validateCrc;
      }
      onChange(newConfig);
    }
  };

  const handleDelimiterChange = (hex: string) => {
    const clean = hex.toUpperCase().replace(/[^0-9A-F]/g, "");
    setDelimiterHex(clean);
    if (currentMode === "delimiter" && clean.length >= 2) {
      onChange({
        mode: "delimiter",
        delimiterHex: clean,
        maxFrameLength: maxLength,
        emitRawBytes: showEmitRawBytes ? emitRawBytes : undefined,
      });
    }
  };

  const handleMaxLengthChange = (value: number) => {
    setMaxLength(value);
    if (currentMode === "delimiter") {
      onChange({
        mode: "delimiter",
        delimiterHex,
        maxFrameLength: value,
        emitRawBytes: showEmitRawBytes ? emitRawBytes : undefined,
      });
    }
  };

  const handleValidateCrcChange = (checked: boolean) => {
    if (currentMode === "modbus_rtu") {
      onChange({
        mode: "modbus_rtu",
        validateCrc: checked,
        emitRawBytes: showEmitRawBytes ? emitRawBytes : undefined,
      });
    }
  };

  const handleEmitRawBytesChange = (checked: boolean) => {
    if (config && config.mode !== "raw") {
      onChange({
        ...config,
        emitRawBytes: checked,
      });
    }
  };

  // Card variant - full button cards with descriptions (for dialogs)
  if (variant === "card") {
    return (
      <div className="space-y-2">
        {/* SLIP Option */}
        <button
          type="button"
          disabled={disabled}
          onClick={() => handleModeChange(currentMode === "slip" ? "raw" : "slip")}
          className={`${toggleCardClass(currentMode === "slip")} ${disabled ? "opacity-50 cursor-not-allowed" : ""}`}
        >
          <div className="font-medium">SLIP</div>
          <div className={`text-xs ${textDataSecondary} mt-0.5`}>RFC 1055 framing with 0xC0 delimiter</div>
        </button>

        {/* Delimiter Option */}
        <button
          type="button"
          disabled={disabled}
          onClick={() => handleModeChange(currentMode === "delimiter" ? "raw" : "delimiter")}
          className={`${toggleCardClass(currentMode === "delimiter")} ${disabled ? "opacity-50 cursor-not-allowed" : ""}`}
        >
          <div className="font-medium">Delimiter</div>
          <div className={`text-xs ${textDataSecondary} mt-0.5`}>Split on custom delimiter bytes</div>
        </button>
        {currentMode === "delimiter" && (
          <div className="ml-4 pl-4 border-l-2 border-blue-600 space-y-3 py-2">
            <label className="block text-sm">
              <span className={textDataSecondary}>Delimiter (hex):</span>
              <input
                type="text"
                value={delimiterHex}
                onChange={(e) => handleDelimiterChange(e.target.value)}
                disabled={disabled}
                className={`w-full mt-1 px-3 py-1.5 ${bgDataInput} border ${borderDataView} rounded text-white disabled:opacity-50`}
                placeholder="0A or 0D0A"
              />
            </label>
            <label className="block text-sm">
              <span className={textDataSecondary}>Max frame length:</span>
              <input
                type="number"
                value={maxLength}
                onChange={(e) => handleMaxLengthChange(Number(e.target.value))}
                disabled={disabled}
                className={`w-full mt-1 px-3 py-1.5 ${bgDataInput} border ${borderDataView} rounded text-white disabled:opacity-50`}
              />
            </label>
          </div>
        )}

        {/* Modbus RTU Option */}
        <button
          type="button"
          disabled={disabled}
          onClick={() => handleModeChange(currentMode === "modbus_rtu" ? "raw" : "modbus_rtu")}
          className={`${toggleCardClass(currentMode === "modbus_rtu")} ${disabled ? "opacity-50 cursor-not-allowed" : ""}`}
        >
          <div className="font-medium">Modbus RTU</div>
          <div className={`text-xs ${textDataSecondary} mt-0.5`}>CRC-16 validation based framing</div>
        </button>
        {currentMode === "modbus_rtu" && (
          <div className="ml-4 pl-4 border-l-2 border-blue-600 py-2">
            <label className="flex items-center gap-2 text-sm text-gray-300">
              <input
                type="checkbox"
                checked={validateCrc}
                onChange={(e) => handleValidateCrcChange(e.target.checked)}
                disabled={disabled}
                className="rounded"
              />
              Validate CRC-16
            </label>
          </div>
        )}

        {/* Emit raw bytes toggle */}
        {showEmitRawBytes && currentMode !== "raw" && (
          <label className="flex items-center gap-2 text-sm text-gray-300 mt-3 cursor-pointer">
            <input
              type="checkbox"
              checked={emitRawBytes}
              onChange={(e) => handleEmitRawBytesChange(e.target.checked)}
              disabled={disabled}
              className="rounded"
            />
            Also capture raw bytes
          </label>
        )}
      </div>
    );
  }

  // Panel variant - compact grid layout (for inline panels)
  return (
    <div className="space-y-3">
      {/* Encoding selection */}
      <div>
        <label className={`block ${caption} mb-1.5`}>
          Encoding
        </label>
        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            disabled={disabled}
            onClick={() => handleModeChange("raw")}
            className={`${toggleChipClass(currentMode === "raw")} ${disabled ? "opacity-50 cursor-not-allowed" : ""}`}
          >
            None
          </button>
          <button
            type="button"
            disabled={disabled}
            onClick={() => handleModeChange("slip")}
            className={`${toggleChipClass(currentMode === "slip")} ${disabled ? "opacity-50 cursor-not-allowed" : ""}`}
          >
            SLIP
          </button>
          <button
            type="button"
            disabled={disabled}
            onClick={() => handleModeChange("delimiter")}
            className={`${toggleChipClass(currentMode === "delimiter")} ${disabled ? "opacity-50 cursor-not-allowed" : ""}`}
          >
            Delimiter
          </button>
          <button
            type="button"
            disabled={disabled}
            onClick={() => handleModeChange("modbus_rtu")}
            className={`${toggleChipClass(currentMode === "modbus_rtu")} ${disabled ? "opacity-50 cursor-not-allowed" : ""}`}
          >
            Modbus RTU
          </button>
        </div>
      </div>

      {/* Delimiter options */}
      {currentMode === "delimiter" && (
        <div className="space-y-2 pl-2 border-l-2 border-[color:var(--accent-primary)]">
          <div>
            <label className={`block ${caption} mb-1`}>
              Delimiter (hex)
            </label>
            <input
              type="text"
              value={delimiterHex}
              onChange={(e) => handleDelimiterChange(e.target.value)}
              disabled={disabled}
              placeholder="0A or 0D0A"
              className={`w-full px-2 py-1.5 text-xs rounded border border-[color:var(--border-default)] ${bgSurface} text-[color:var(--text-secondary)] disabled:opacity-50`}
            />
            <div className={`${captionMuted} mt-0.5`}>
              LF=0A, CR=0D, CRLF=0D0A
            </div>
          </div>
          <div>
            <label className={`block ${caption} mb-1`}>
              Max frame length
            </label>
            <input
              type="number"
              min="1"
              max="65535"
              value={maxLength}
              onChange={(e) => handleMaxLengthChange(Number(e.target.value))}
              disabled={disabled}
              className={`w-full px-2 py-1.5 text-xs rounded border border-[color:var(--border-default)] ${bgSurface} text-[color:var(--text-secondary)] disabled:opacity-50`}
            />
          </div>
        </div>
      )}

      {/* Modbus RTU options */}
      {currentMode === "modbus_rtu" && (
        <div className="pl-2 border-l-2 border-[color:var(--accent-primary)]">
          <label className="flex items-center gap-2 text-xs text-[color:var(--text-secondary)] cursor-pointer">
            <input
              type="checkbox"
              checked={validateCrc}
              onChange={(e) => handleValidateCrcChange(e.target.checked)}
              disabled={disabled}
              className="rounded border-[color:var(--border-default)]"
            />
            <span>Validate CRC-16</span>
          </label>
        </div>
      )}

      {/* Emit raw bytes toggle (when framing is enabled) */}
      {showEmitRawBytes && currentMode !== "raw" && (
        <label className="flex items-center gap-2 text-xs text-[color:var(--text-secondary)] cursor-pointer">
          <input
            type="checkbox"
            checked={emitRawBytes}
            onChange={(e) => handleEmitRawBytesChange(e.target.checked)}
            disabled={disabled}
            className="rounded border-[color:var(--border-default)]"
          />
          <span>Also capture raw bytes</span>
        </label>
      )}
    </div>
  );
}
