// ui/src/apps/catalog/views/protocol-editors/SerialConfigSection.tsx

import type { SerialConfig, SerialEncoding } from "../../types";
import { caption, textMedium, focusRing } from "../../../../styles";

export type SerialConfigSectionProps = {
  config: SerialConfig;
  onChange: (config: SerialConfig) => void;
  /** Catalog-level encoding from [frame.serial.config] - read-only info */
  catalogEncoding?: SerialEncoding;
};

export default function SerialConfigSection({
  config,
  onChange,
  catalogEncoding,
}: SerialConfigSectionProps) {
  // Convert delimiter array to hex string for display
  const delimiterToString = (delimiter?: number[]): string => {
    if (!delimiter || delimiter.length === 0) return "";
    return delimiter.map((b) => `0x${b.toString(16).padStart(2, "0").toUpperCase()}`).join(", ");
  };

  // Parse hex string back to delimiter array
  const parseDelimiter = (input: string): number[] | undefined => {
    if (!input.trim()) return undefined;
    const parts = input.split(",").map((s) => s.trim()).filter(Boolean);
    const bytes: number[] = [];
    for (const part of parts) {
      const num = part.startsWith("0x") || part.startsWith("0X")
        ? parseInt(part, 16)
        : parseInt(part, 10);
      if (isNaN(num) || num < 0 || num > 255) return undefined;
      bytes.push(num);
    }
    return bytes.length > 0 ? bytes : undefined;
  };

  // Encoding display name
  const encodingDisplayName = (enc?: SerialEncoding): string => {
    switch (enc) {
      case "slip": return "SLIP";
      case "cobs": return "COBS";
      case "raw": return "Raw";
      case "length_prefixed": return "Length Prefixed";
      default: return "Not configured";
    }
  };

  return (
    <div className="space-y-4">
      {/* Frame ID - Required */}
      <div>
        <label className={`block ${textMedium} mb-2`}>
          Frame Identifier <span className="text-red-500">*</span>
        </label>
        <input
          type="text"
          value={config.frame_id ?? ""}
          onChange={(e) => onChange({ ...config, frame_id: e.target.value || undefined })}
          className={`w-full px-4 py-2 bg-[var(--bg-surface)] border border-[color:var(--border-default)] rounded-lg text-[color:var(--text-primary)] ${focusRing}`}
          placeholder="status_frame"
        />
        <p className={`${caption} mt-1`}>
          A unique identifier for this serial frame
        </p>
      </div>

      {/* Encoding - Read-only, from catalog config */}
      <div>
        <label className={`block ${textMedium} mb-2`}>
          Encoding
        </label>
        <div className="w-full px-4 py-2 bg-[var(--bg-surface)] border border-[color:var(--border-default)] rounded-lg text-[color:var(--text-secondary)]">
          {encodingDisplayName(catalogEncoding)}
        </div>
        <p className={`${caption} mt-1`}>
          Encoding is set at catalog level in [frame.serial.config]
        </p>
      </div>

      {/* Delimiter - Only for raw encoding */}
      {catalogEncoding === "raw" && (
        <div>
          <label className={`block ${textMedium} mb-2`}>
            Delimiter
          </label>
          <input
            type="text"
            value={delimiterToString(config.delimiter)}
            onChange={(e) => {
              const delimiter = parseDelimiter(e.target.value);
              onChange({ ...config, delimiter });
            }}
            className={`w-full px-4 py-2 bg-[var(--bg-surface)] border border-[color:var(--border-default)] rounded-lg text-[color:var(--text-primary)] font-mono ${focusRing}`}
            placeholder="0x0D, 0x0A"
          />
          <p className={`${caption} mt-1`}>
            Byte sequence marking frame boundaries (comma-separated hex or decimal)
          </p>
        </div>
      )}

      {/* Max Length - Optional */}
      <div>
        <label className={`block ${textMedium} mb-2`}>
          Max Length
        </label>
        <input
          type="number"
          min="1"
          value={config.max_length ?? ""}
          onChange={(e) =>
            onChange({
              ...config,
              max_length: e.target.value ? parseInt(e.target.value) : undefined,
            })
          }
          className={`w-full px-4 py-2 bg-[var(--bg-surface)] border border-[color:var(--border-default)] rounded-lg text-[color:var(--text-primary)] ${focusRing}`}
          placeholder="256"
        />
        <p className={`${caption} mt-1`}>
          Maximum frame length in bytes (optional)
        </p>
      </div>
    </div>
  );
}
