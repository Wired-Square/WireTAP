// ui/src/apps/discovery/views/tools/ChangesToolPanel.tsx

import { useDiscoveryStore } from "../../../../stores/discoveryStore";
import { bgSurface } from "../../../../styles";

export default function ChangesToolPanel() {
  const options = useDiscoveryStore((s) => s.toolbox.changes);
  const updateOptions = useDiscoveryStore((s) => s.updateChangesOptions);

  return (
    <div className="space-y-2 text-xs">
      <div className="space-y-1">
        <label className="text-[color:var(--text-muted)]">Max Change Examples</label>
        <input
          type="number"
          min={1}
          max={100}
          value={options.maxExamples}
          onChange={(e) => updateOptions({ maxExamples: Math.max(1, Math.min(100, Number(e.target.value) || 30)) })}
          className={`w-full px-2 py-1 rounded border border-[color:var(--border-default)] ${bgSurface} text-[color:var(--text-primary)]`}
        />
      </div>
      <p className="text-[color:var(--text-muted)]">
        Maximum unique payload samples to analyse per frame ID.
      </p>
    </div>
  );
}
