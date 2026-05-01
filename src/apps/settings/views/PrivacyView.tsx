// ui/src/apps/settings/views/PrivacyView.tsx

import { useTranslation } from "react-i18next";
import { labelDefault, helpText } from "../../../styles";

type PrivacyViewProps = {
  telemetryEnabled: boolean;
  onChangeTelemetryEnabled: (value: boolean) => void;
};

export default function PrivacyView({
  telemetryEnabled,
  onChangeTelemetryEnabled,
}: PrivacyViewProps) {
  const { t } = useTranslation("settings");

  return (
    <div className="space-y-6">
      <h2 className="text-xl font-semibold text-[color:var(--text-primary)]">
        {t("privacy.title")}
      </h2>

      {/* Telemetry */}
      <div className="space-y-2">
        <label className="flex items-start gap-3 cursor-pointer">
          <input
            type="checkbox"
            checked={telemetryEnabled}
            onChange={(e) => onChangeTelemetryEnabled(e.target.checked)}
            className="mt-1"
          />
          <div>
            <span className={labelDefault}>{t("privacy.telemetry.label")}</span>
            <p className={helpText}>{t("privacy.telemetry.help")}</p>
          </div>
        </label>
      </div>
    </div>
  );
}
