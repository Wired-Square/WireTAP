// ui/src/apps/analysis/FrameOrderAnalysis.tsx
// Frame Order Analysis results panel - displays MessageOrderResultView in its own app tab

import { useTranslation } from "react-i18next";
import { useDiscoveryStore } from "../../stores/discoveryStore";
import MessageOrderResultView from "../discovery/views/tools/MessageOrderResultView";
import { bgSurface } from "../../styles/colourTokens";
import { emptyStateContainer, emptyStateText, emptyStateHeading, emptyStateDescription } from "../../styles/typography";

export default function FrameOrderAnalysis() {
  const { t } = useTranslation("analysis");
  const results = useDiscoveryStore((s) => s.toolbox.messageOrderResults);

  if (!results) {
    return (
      <div className={`h-full ${emptyStateContainer} ${bgSurface}`}>
        <div className={emptyStateText}>
          <p className={emptyStateHeading}>{t("frameOrder.emptyHeading")}</p>
          <p className={emptyStateDescription}>{t("frameOrder.emptyDescription")}</p>
        </div>
      </div>
    );
  }

  // Render the existing MessageOrderResultView - not embedded since this is its own panel
  return (
    <div className="h-full bg-[var(--bg-surface)]">
      <MessageOrderResultView />
    </div>
  );
}
