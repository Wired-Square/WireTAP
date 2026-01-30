// ui/src/apps/analysis/FrameOrderAnalysis.tsx
// Frame Order Analysis results panel - displays MessageOrderResultView in its own app tab

import { useDiscoveryStore } from "../../stores/discoveryStore";
import MessageOrderResultView from "../discovery/views/tools/MessageOrderResultView";

export default function FrameOrderAnalysis() {
  const results = useDiscoveryStore((s) => s.toolbox.messageOrderResults);

  if (!results) {
    return (
      <div className="h-full flex flex-col items-center justify-center bg-[var(--bg-surface)] text-center p-8">
        <div className="max-w-md">
          <h2 className="text-lg font-semibold text-[color:var(--text-secondary)] mb-2">
            No Frame Order Analysis Results
          </h2>
          <p className="text-sm text-[color:var(--text-muted)]">
            Run the Frame Order Analysis tool from Discovery to see results here.
          </p>
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
