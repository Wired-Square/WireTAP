// ui/src/apps/graph/views/panels/PanelWrapper.tsx

import { type ReactNode } from "react";
import { X, Settings2, Plus, Copy } from "lucide-react";
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
  const clonePanel = useGraphStore((s) => s.clonePanel);
  const removePanel = useGraphStore((s) => s.removePanel);

  return (
    <div className="group/panel flex flex-col h-full bg-[var(--bg-surface)] border border-[var(--border-default)] rounded-lg overflow-hidden">
      {/* Header — drag handle; icon bar hidden until panel hover */}
      <div className="drag-handle cursor-grab active:cursor-grabbing select-none border-b border-[var(--border-default)] bg-[var(--bg-primary)]">
        {/* Icon bar — collapsed by default, revealed on hover */}
        <div className="grid grid-rows-[0fr] group-hover/panel:grid-rows-[1fr] transition-[grid-template-rows] duration-150">
          <div className="overflow-hidden">
            <div className="flex items-center justify-end gap-0.5 px-1.5 py-0.5">
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

              {/* Clone */}
              <button
                onClick={() => clonePanel(panel.id)}
                className={`p-0.5 rounded ${iconButtonHover}`}
                title="Clone panel"
              >
                <Copy className={iconSm} />
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
          </div>
        </div>

        {/* Title — always visible */}
        <div className="px-2 py-0.5 text-xs font-medium text-[color:var(--text-primary)] truncate">
          {panel.title}
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 min-h-0 overflow-hidden">
        {children}
      </div>
    </div>
  );
}
