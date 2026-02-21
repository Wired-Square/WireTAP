// ui/src/apps/settings/views/PrivacyView.tsx

import { labelDefault, helpText } from "../../../styles";

type PrivacyViewProps = {
  telemetryEnabled: boolean;
  onChangeTelemetryEnabled: (value: boolean) => void;
};

export default function PrivacyView({
  telemetryEnabled,
  onChangeTelemetryEnabled,
}: PrivacyViewProps) {
  return (
    <div className="space-y-6">
      <h2 className="text-xl font-semibold text-[color:var(--text-primary)]">Privacy</h2>

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
            <span className={labelDefault}>Send anonymous crash reports</span>
            <p className={helpText}>
              Help improve CANdor by sending anonymous crash and error reports
              via Sentry. No personal data, CAN bus data, or usage analytics are
              collected — only error stack traces.
            </p>
          </div>
        </label>
      </div>
    </div>
  );
}
