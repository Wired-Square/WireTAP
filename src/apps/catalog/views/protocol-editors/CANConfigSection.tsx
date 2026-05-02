// ui/src/apps/catalog/views/protocol-editors/CANConfigSection.tsx

import { useTranslation } from "react-i18next";
import type { CANConfig } from "../../types";
import { flexRowGap2 } from "../../../../styles/spacing";
import { caption, textMedium, focusRing, checkboxDefault } from "../../../../styles";

export type CANConfigSectionProps = {
  config: CANConfig;
  onChange: (config: CANConfig) => void;
  existingIds?: string[];
  originalId?: string;
};

export default function CANConfigSection({
  config,
  onChange,
}: CANConfigSectionProps) {
  const { t } = useTranslation("catalog");
  return (
    <div className="space-y-4">
      {/* ID - Required */}
      <div>
        <label className={`block ${textMedium} mb-2`}>
          {t("protocolEditors.canIdLabel")} <span className="text-red-500">{t("protocolEditors.canIdRequired")}</span>
        </label>
        <input
          type="text"
          value={config.id}
          onChange={(e) => onChange({ ...config, id: e.target.value })}
          className={`w-full px-4 py-2 bg-[var(--bg-surface)] border border-[color:var(--border-default)] rounded-lg text-[color:var(--text-primary)] font-mono ${focusRing}`}
          placeholder={t("protocolEditors.canIdPlaceholder")}
        />
        <p className={`${caption} mt-1`}>
          {t("protocolEditors.canIdHint")}
        </p>
      </div>

      {/* Extended ID checkbox */}
      <div className={flexRowGap2}>
        <input
          type="checkbox"
          id="extended"
          checked={config.extended ?? false}
          onChange={(e) => onChange({ ...config, extended: e.target.checked || undefined })}
          className={checkboxDefault}
        />
        <label htmlFor="extended" className="text-sm text-[color:var(--text-secondary)]">
          {t("protocolEditors.canExtendedLabel")}
        </label>
      </div>

      {/* Bus - Optional */}
      <div>
        <label className={`block ${textMedium} mb-2`}>
          {t("protocolEditors.canBusLabel")}
        </label>
        <input
          type="number"
          min="0"
          value={config.bus ?? ""}
          onChange={(e) =>
            onChange({
              ...config,
              bus: e.target.value ? parseInt(e.target.value) : undefined,
            })
          }
          className={`w-full px-4 py-2 bg-[var(--bg-surface)] border border-[color:var(--border-default)] rounded-lg text-[color:var(--text-primary)] ${focusRing}`}
          placeholder={t("protocolEditors.canBusPlaceholder")}
        />
        <p className={`${caption} mt-1`}>
          {t("protocolEditors.canBusHint")}
        </p>
      </div>

      {/* Copy from - Optional (mutually exclusive with Mirror Of) */}
      <div>
        <label className={`block ${textMedium} mb-2`}>
          {t("protocolEditors.canCopyFromLabel")}
        </label>
        <input
          type="text"
          value={config.copy ?? ""}
          onChange={(e) =>
            onChange({
              ...config,
              copy: e.target.value || undefined,
              mirror_of: undefined, // Clear mirror when setting copy
            })
          }
          disabled={!!config.mirror_of}
          className={`w-full px-4 py-2 bg-[var(--bg-surface)] border border-[color:var(--border-default)] rounded-lg text-[color:var(--text-primary)] font-mono ${focusRing} disabled:opacity-50 disabled:cursor-not-allowed`}
          placeholder={t("protocolEditors.canCopyFromPlaceholder")}
        />
        <p className={`${caption} mt-1`}>
          {t("protocolEditors.canCopyFromHint")}
        </p>
      </div>

      {/* Mirror Of - Optional (mutually exclusive with Copy From) */}
      <div>
        <label className={`block ${textMedium} mb-2`}>
          {t("protocolEditors.canMirrorOfLabel")}
        </label>
        <input
          type="text"
          value={config.mirror_of ?? ""}
          onChange={(e) =>
            onChange({
              ...config,
              mirror_of: e.target.value || undefined,
              copy: undefined, // Clear copy when setting mirror
            })
          }
          disabled={!!config.copy}
          className={`w-full px-4 py-2 bg-[var(--bg-surface)] border border-[color:var(--border-default)] rounded-lg text-[color:var(--text-primary)] font-mono ${focusRing} disabled:opacity-50 disabled:cursor-not-allowed`}
          placeholder={t("protocolEditors.canMirrorOfPlaceholder")}
        />
        <p className={`${caption} mt-1`}>
          {t("protocolEditors.canMirrorOfHint")}
        </p>
      </div>
    </div>
  );
}
