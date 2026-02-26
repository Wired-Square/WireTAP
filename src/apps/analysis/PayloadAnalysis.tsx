// ui/src/apps/analysis/PayloadAnalysis.tsx
// Payload Analysis results panel - displays ChangesResultView in its own app tab

import { useDiscoveryStore } from "../../stores/discoveryStore";
import ChangesResultView from "../discovery/views/tools/ChangesResultView";
import { bgSurface } from "../../styles/colourTokens";
import { emptyStateContainer, emptyStateText, emptyStateHeading, emptyStateDescription } from "../../styles/typography";

export default function PayloadAnalysis() {
  const results = useDiscoveryStore((s) => s.toolbox.changesResults);

  if (!results) {
    return (
      <div className={`h-full ${emptyStateContainer} ${bgSurface}`}>
        <div className={emptyStateText}>
          <p className={emptyStateHeading}>No Payload Analysis Results</p>
          <p className={emptyStateDescription}>
            Run the Payload Change Analysis tool from Discovery to see results here.
          </p>
        </div>
      </div>
    );
  }

  // Render the existing ChangesResultView - not embedded since this is its own panel
  return (
    <div className="h-full bg-[var(--bg-surface)]">
      <ChangesResultView />
    </div>
  );
}
