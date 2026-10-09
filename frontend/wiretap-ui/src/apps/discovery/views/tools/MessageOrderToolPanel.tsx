// ui/src/apps/discovery/views/tools/MessageOrderToolPanel.tsx

import { useDiscoveryStore } from "../../../../stores/discoveryStore";
import { toolPanelLabel } from "../../../../styles/typography";
import { Input } from "../../../../components/forms";

const MAX_STANDARD_ID = 0x7ff;

export default function MessageOrderToolPanel() {
  const options = useDiscoveryStore((s) => s.toolbox.messageOrder);
  const updateOptions = useDiscoveryStore((s) => s.updateMessageOrderOptions);

  return (
    <div className="space-y-2 text-xs">
      <div className="space-y-1">
        <label className={toolPanelLabel}>
          Start Message ID <span className="text-muted">(optional)</span>
        </label>
        <Input
          type="text"
          placeholder="Auto-detect"
          value={options.start ? `0x${options.start.frameId.toString(16).toUpperCase()}` : ""}
          onChange={(e) => {
            const val = e.target.value.trim();
            if (!val) {
              updateOptions({ start: null });
            } else {
              const parsed = parseInt(val, val.toLowerCase().startsWith("0x") ? 16 : 10);
              if (!isNaN(parsed)) {
                updateOptions({ start: { frameId: parsed, isExtended: parsed > MAX_STANDARD_ID } });
              }
            }
          }}
          mono
        />
        <p className="text-muted text-2xs">
          Leave empty to auto-detect from gap analysis
        </p>
      </div>
    </div>
  );
}
