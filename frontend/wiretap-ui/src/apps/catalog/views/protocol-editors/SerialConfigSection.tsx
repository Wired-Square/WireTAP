// ui/src/apps/catalog/views/protocol-editors/SerialConfigSection.tsx

import { useTranslation } from "react-i18next";
import type { SerialConfig } from "../../types";
import { caption, textMedium } from "../../../../styles";
import { Input } from "../../../../components/forms";

export type SerialConfigSectionProps = {
  config: SerialConfig;
  onChange: (config: SerialConfig) => void;
};

export default function SerialConfigSection({ config, onChange }: SerialConfigSectionProps) {
  const { t } = useTranslation("catalog");

  return (
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
  );
}
