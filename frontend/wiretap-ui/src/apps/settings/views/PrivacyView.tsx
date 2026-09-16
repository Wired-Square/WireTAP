// ui/src/apps/settings/views/PrivacyView.tsx

import { useTranslation } from "react-i18next";
import { h2 } from "../../../styles";
import { SettingToggleRow } from "../components/rows";

type PrivacyViewProps = {
  telemetryEnabled: boolean;
  onChangeTelemetryEnabled: (value: boolean) => void;
  usageAnalyticsEnabled: boolean;
  onChangeUsageAnalyticsEnabled: (value: boolean) => void;
};

export default function PrivacyView({
  telemetryEnabled,
  onChangeTelemetryEnabled,
  usageAnalyticsEnabled,
  onChangeUsageAnalyticsEnabled,
}: PrivacyViewProps) {
  const { t } = useTranslation("settings");

  return (
    <div className="space-y-6">
      <h2 className={h2}>{t("privacy.title")}</h2>

      <SettingToggleRow
        label={t("privacy.telemetry.label")}
        help={t("privacy.telemetry.help")}
        checked={telemetryEnabled}
        onChange={onChangeTelemetryEnabled}
      />

      <SettingToggleRow
        label={t("privacy.usageAnalytics.label")}
        help={t("privacy.usageAnalytics.help")}
        checked={usageAnalyticsEnabled}
        onChange={onChangeUsageAnalyticsEnabled}
      />
    </div>
  );
}
