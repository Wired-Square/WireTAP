// ui/src/apps/graph/views/panels/PanelWrapper.tsx

import { type ReactNode } from "react";
import { X, Settings2, Plus } from "lucide-react";
import { iconSm } from "../../../../styles/spacing";
import { iconButtonHover, iconButtonHoverDanger } from "../../../../styles/buttonStyles";
import { useGraphStore, type GraphPanel } from "../../../../stores/graphStore";

interface Props {
  panel: GraphPanel;
  onOpenSignalPicker: () => void;
  onOpenPanelConfig: () => void;
  children: ReactNode;
}

export default function PanelWrapper({ panel, onOpenSignalPicker, onOpenPanelConfig, children }: Props) {
  const removePanel = useGraphStore((s) => s.removePanel);

  return (
    <div className="flex flex-col h-full bg-[var(--bg-surface)] border border-[var(--border-default)] rounded-lg overflow-hidden">
      {/* Title bar — drag handle */}
      <div className="drag-handle flex items-center gap-1 px-2 py-1 cursor-grab active:cursor-grabbing select-none border-b border-[var(--border-default)] bg-[var(--bg-primary)]">
        <span className="text-xs font-medium text-[color:var(--text-primary)] truncate flex-1">
          {panel.title}
        </span>

        {/* Signal count badge */}
        {panel.signals.length > 0 && (
          <span
            className="w-4 h-4 rounded-full text-[10px] font-medium tabular-nums flex items-center justify-center shrink-0 bg-[var(--border-default)] text-[color:var(--text-secondary)]"
            title={`${panel.signals.length} signal${panel.signals.length !== 1 ? "s" : ""}`}
          >
            {panel.signals.length}
          </span>
        )}

        {/* Add signal */}
        <button
          onClick={onOpenSignalPicker}
          className={`p-0.5 rounded ${iconButtonHover}`}
          title="Add signals"
        >
          <Plus className={iconSm} />
        </button>

        {/* Configure */}
        <button
          onClick={onOpenPanelConfig}
          className={`p-0.5 rounded ${iconButtonHover}`}
          title="Configure panel"
        >
          <Settings2 className={iconSm} />
        </button>

        {/* Close */}
        <button
          onClick={() => removePanel(panel.id)}
          className={`p-0.5 rounded ${iconButtonHoverDanger}`}
          title="Remove panel"
        >
          <X className={iconSm} />
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 min-h-0 overflow-hidden">
        {children}
      </div>
    </div>
  );
}
