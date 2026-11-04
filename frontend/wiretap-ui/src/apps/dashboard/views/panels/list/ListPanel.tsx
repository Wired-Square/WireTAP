// ui/src/apps/dashboard/views/panels/list/ListPanel.tsx

import { getSignalLabel, getConfidenceColour, type DashboardPanel } from "../../../../../stores/dashboardStore";
import { useTranslation } from "react-i18next";
import { useSignalReadouts } from "../../../widgets/useSignalValues";
import { useSettings } from "../../../../../hooks/useSettings";
import { emptyStateContainer, emptyStateText } from "../../../../../styles/typography";
import PanelTooltip from "../PanelTooltip";

interface Props {
  panel: DashboardPanel;
}

export default function ListPanel({ panel }: Props) {
  const { t } = useTranslation("dashboard");
  const { settings } = useSettings();

  const readouts = useSignalReadouts(panel.signals);

  if (panel.signals.length === 0) {
    return (
      <div className={emptyStateContainer}>
        <p className={emptyStateText}>{t("panel.emptyAddSignals")}</p>
      </div>
    );
  }

  return (
    <PanelTooltip
      signals={panel.signals}
      settings={settings}
      className="h-full overflow-y-auto px-2 py-1"
    >
      {panel.signals.map((signal, i) => (
        <div
          key={`${signal.frameId}:${signal.signalName}`}
          className="flex items-center gap-2 py-1 border-b border-default last:border-b-0"
        >
          {/* Confidence dot */}
          <span
            className="w-2 h-2 rounded-full shrink-0"
            style={{ background: getConfidenceColour(signal.confidence, settings) }}
          />

          {/* Signal name */}
          <span className="text-xs text-secondary truncate flex-1">
            {getSignalLabel(signal)}
          </span>

          {/* Value */}
          <span className="text-xs font-mono font-medium text-primary tabular-nums shrink-0">
            {readouts[i]}
          </span>

          {/* Unit */}
          {signal.unit && (
            <span className="text-2xs text-muted shrink-0">
              {signal.unit}
            </span>
          )}
        </div>
      ))}
    </PanelTooltip>
  );
}
