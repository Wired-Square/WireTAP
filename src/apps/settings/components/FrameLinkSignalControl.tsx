// Per-signal control for FrameLink interface configuration.
// Renders appropriate input based on signal format and interface type:
// toggle (bool), bitrate select (CAN or UART), enum dropdown,
// stop/data bits select, number input, or read-only display.

import { useState, useCallback } from "react";
import { Loader2 } from "lucide-react";
import { iconXs } from "../../../styles/spacing";
import { Input, Select, FormField } from "../../../components/forms";
import { caption, textMuted } from "../../../styles";
import type { SignalDescriptor } from "../../../api/framelink";

const CAN_BITRATES = [
  { value: 10000, label: "10 Kbit/s" },
  { value: 20000, label: "20 Kbit/s" },
  { value: 50000, label: "50 Kbit/s" },
  { value: 100000, label: "100 Kbit/s" },
  { value: 125000, label: "125 Kbit/s" },
  { value: 250000, label: "250 Kbit/s" },
  { value: 500000, label: "500 Kbit/s" },
  { value: 750000, label: "750 Kbit/s" },
  { value: 1000000, label: "1 Mbit/s" },
];

const UART_BITRATES = [
  { value: 300, label: "300" },
  { value: 1200, label: "1,200" },
  { value: 2400, label: "2,400" },
  { value: 4800, label: "4,800" },
  { value: 9600, label: "9,600" },
  { value: 14400, label: "14,400" },
  { value: 19200, label: "19,200" },
  { value: 38400, label: "38,400" },
  { value: 57600, label: "57,600" },
  { value: 115200, label: "115,200" },
  { value: 230400, label: "230,400" },
  { value: 460800, label: "460,800" },
  { value: 921600, label: "921,600" },
];

// Zephyr UART enum values: UART_CFG_STOP_BITS_1 = 1, UART_CFG_STOP_BITS_2 = 3
const STOP_BITS = [
  { value: 1, label: "1" },
  { value: 3, label: "2" },
];

// Zephyr UART enum values: UART_CFG_DATA_BITS_5..9 = 0..4
const DATA_BITS = [
  { value: 0, label: "5" },
  { value: 1, label: "6" },
  { value: 2, label: "7" },
  { value: 3, label: "8" },
];

// RS-485 (3) and RS-232 (4) use UART bitrates
function isSerialInterface(ifaceType: number): boolean {
  return ifaceType === 3 || ifaceType === 4;
}

function nameContains(name: string, term: string): boolean {
  return name.toLowerCase().includes(term.toLowerCase());
}

/** Sort priority for UART-style signal ordering: bitrate, data bits, parity, stop bits. */
export function signalSortKey(name: string): number {
  const lower = name.toLowerCase();
  if (lower.includes("bitrate")) return 0;
  if (lower.includes("data bit")) return 1;
  if (lower.includes("parity")) return 2;
  if (lower.includes("stop bit")) return 3;
  return 10;
}

type Props = {
  signal: SignalDescriptor;
  isFetched: boolean;
  onWrite: (signalId: number, value: number) => Promise<void>;
};

export default function FrameLinkSignalControl({ signal, isFetched, onWrite }: Props) {
  const [isWriting, setIsWriting] = useState(false);
  const [localValue, setLocalValue] = useState<string>(String(signal.value));

  const disabled = !isFetched || isWriting;

  const handleWrite = useCallback(
    async (value: number) => {
      setIsWriting(true);
      try {
        await onWrite(signal.signal_id, value);
      } finally {
        setIsWriting(false);
      }
    },
    [signal.signal_id, onWrite],
  );

  const spinner = isWriting ? (
    <Loader2 className={`${iconXs} animate-spin ${textMuted}`} />
  ) : null;

  const unitLabel = signal.unit ? ` ${signal.unit}` : "";

  // Non-writable: read-only display
  if (!signal.writable) {
    return (
      <FormField label={signal.name} variant="default">
        <div className={`${caption} py-1.5`}>
          {signal.formatted_value}{unitLabel}
        </div>
      </FormField>
    );
  }

  // Bool: toggle switch
  if (signal.format === "bool") {
    const checked = signal.value !== 0;
    return (
      <FormField label={signal.name} variant="default">
        <div className="flex items-center gap-2 relative">
          <button
            type="button"
            role="switch"
            aria-checked={checked}
            disabled={disabled}
            onClick={() => handleWrite(checked ? 0 : 1)}
            className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors ${
              checked
                ? "bg-[var(--accent-primary)]"
                : "bg-[var(--bg-tertiary)]"
            } ${disabled ? "opacity-50 cursor-not-allowed" : ""}`}
          >
            <span
              className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${
                checked ? "translate-x-4" : "translate-x-0"
              }`}
            />
          </button>
          {spinner}
        </div>
      </FormField>
    );
  }

  // Bitrate: CAN or UART depending on interface type
  if (signal.unit === "bps") {
    const bitrates = isSerialInterface(signal.iface_type) ? UART_BITRATES : CAN_BITRATES;
    return (
      <FormField label={signal.name} variant="default">
        <div className="flex items-center gap-2 relative">
          <Select
            variant="default"
            value={String(signal.value)}
            disabled={disabled}
            onChange={(e) => handleWrite(Number(e.target.value))}
          >
            {bitrates.map((br) => (
              <option key={br.value} value={br.value}>
                {br.label}
              </option>
            ))}
          </Select>
          {spinner}
        </div>
      </FormField>
    );
  }

  // Stop Bits: select with standard values
  if (nameContains(signal.name, "Stop Bit")) {
    return (
      <FormField label={signal.name} variant="default">
        <div className="flex items-center gap-2 relative">
          <Select
            variant="default"
            value={String(signal.value)}
            disabled={disabled}
            onChange={(e) => handleWrite(Number(e.target.value))}
          >
            {STOP_BITS.map((sb) => (
              <option key={sb.value} value={sb.value}>
                {sb.label}
              </option>
            ))}
          </Select>
          {spinner}
        </div>
      </FormField>
    );
  }

  // Data Bits: select with standard values
  if (nameContains(signal.name, "Data Bit")) {
    return (
      <FormField label={signal.name} variant="default">
        <div className="flex items-center gap-2 relative">
          <Select
            variant="default"
            value={String(signal.value)}
            disabled={disabled}
            onChange={(e) => handleWrite(Number(e.target.value))}
          >
            {DATA_BITS.map((db) => (
              <option key={db.value} value={db.value}>
                {db.label}
              </option>
            ))}
          </Select>
          {spinner}
        </div>
      </FormField>
    );
  }

  // Enum: dropdown
  if (signal.format === "enum" && Object.keys(signal.enum_values).length > 0) {
    return (
      <FormField label={signal.name} variant="default">
        <div className="flex items-center gap-2 relative">
          <Select
            variant="default"
            value={String(signal.value)}
            disabled={disabled}
            onChange={(e) => handleWrite(Number(e.target.value))}
          >
            {Object.entries(signal.enum_values).map(([key, label]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
          </Select>
          {spinner}
        </div>
      </FormField>
    );
  }

  // Number: text input with commit on blur/Enter
  if (signal.format === "number" || signal.format === "temperature_0.1" || !signal.format) {
    return (
      <FormField label={signal.name} variant="default">
        <div className="flex items-center gap-2 relative">
          <Input
            variant="default"
            type="number"
            value={localValue}
            disabled={disabled}
            onChange={(e) => setLocalValue(e.target.value)}
            onBlur={() => {
              const v = Number(localValue);
              if (!isNaN(v) && v !== signal.value) {
                handleWrite(v);
              }
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                const v = Number(localValue);
                if (!isNaN(v) && v !== signal.value) {
                  handleWrite(v);
                }
              }
            }}
          />
          {unitLabel && <span className={caption}>{unitLabel}</span>}
          {spinner}
        </div>
      </FormField>
    );
  }

  // Fallback: read-only display for unrecognised formats
  return (
    <FormField label={signal.name} variant="default">
      <div className={`${caption} py-1.5`}>
        {signal.formatted_value}{unitLabel}
      </div>
    </FormField>
  );
}
