// ui/src/apps/discovery/views/tools/MessageOrderToolPanel.tsx

import { useDiscoveryStore } from "../../../../stores/discoveryStore";
import { bgSurface } from "../../../../styles";

export default function MessageOrderToolPanel() {
  const options = useDiscoveryStore((s) => s.toolbox.messageOrder);
  const updateOptions = useDiscoveryStore((s) => s.updateMessageOrderOptions);

  return (
    <div className="space-y-2 text-xs">
      <div className="space-y-1">
        <label className="text-[color:var(--text-muted)]">
          Start Message ID <span className="text-[color:var(--text-muted)]">(optional)</span>
        </label>
        <input
          type="text"
          placeholder="Auto-detect"
          value={options.startMessageId !== null ? `0x${options.startMessageId.toString(16).toUpperCase()}` : ""}
          onChange={(e) => {
            const val = e.target.value.trim();
            if (!val) {
              updateOptions({ startMessageId: null });
            } else {
              const parsed = parseInt(val, val.toLowerCase().startsWith("0x") ? 16 : 10);
              if (!isNaN(parsed)) {
                updateOptions({ startMessageId: parsed });
              }
            }
          }}
          className={`w-full px-2 py-1 rounded border border-[color:var(--border-default)] ${bgSurface} text-[color:var(--text-primary)] font-mono`}
        />
        <p className="text-[color:var(--text-muted)] text-[10px]">
          Leave empty to auto-detect from gap analysis
        </p>
      </div>
    </div>
  );
}
