// ui/src/apps/catalog/views/protocol-editors/SerialConfigSection.tsx

import { useTranslation } from "react-i18next";
import type { SerialConfig, SerialEncoding } from "../../types";
import { caption, textMedium } from "../../../../styles";
import { Input } from "../../../../components/forms";

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
  const { t } = useTranslation("catalog");
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

  return (
    <div className="space-y-4">
      {/* Frame ID - Required */}
      <div>
        <label className={`block ${textMedium} mb-2`}>
          {t("protocolEditors.serialFrameIdLabel")} <span className="text-danger">{t("protocolEditors.serialFrameIdRequired")}</span>
        </label>
        <Input
          type="text"
          value={config.frame_id ?? ""}
          onChange={(e) => onChange({ ...config, frame_id: e.target.value || undefined })}
          size="lg"
          placeholder={t("protocolEditors.serialFrameIdPlaceholder")}
        />
        <p className={`${caption} mt-1`}>
          {t("protocolEditors.serialFrameIdHint")}
        </p>
      </div>

      {/* Delimiter - Only for raw encoding */}
      {catalogEncoding === "raw" && (
        <div>
          <label className={`block ${textMedium} mb-2`}>
            {t("protocolEditors.serialDelimiterLabel")}
          </label>
          <Input
            type="text"
            value={delimiterToString(config.delimiter)}
            onChange={(e) => {
              const delimiter = parseDelimiter(e.target.value);
              onChange({ ...config, delimiter });
            }}
            size="lg"
            mono
            placeholder={t("protocolEditors.serialDelimiterPlaceholder")}
          />
          <p className={`${caption} mt-1`}>
            {t("protocolEditors.serialDelimiterHint")}
          </p>
        </div>
      )}
    </div>
  );
}
