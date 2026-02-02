// ui/src/components/AppTab.tsx
// Custom Dockview tab component with colored icons

import { useState, useEffect } from "react";
import { type IDockviewPanelHeaderProps } from "dockview-react";
import { Search, Activity, FileText, Calculator, GitCompare, ListOrdered, Scan, Send, Settings, DatabaseZap, Network, X } from "lucide-react";
import { iconMd, iconXs } from "../styles/spacing";

type PanelId = "discovery" | "decoder" | "catalog-editor" | "frame-calculator" | "payload-analysis" | "frame-order-analysis" | "serial-frame-analysis" | "transmit" | "query" | "session-manager" | "settings";

// Icon and color config for each panel
const panelConfig: Record<PanelId, { icon: typeof Search; color: string }> = {
  discovery: { icon: Search, color: "text-purple-400" },
  decoder: { icon: Activity, color: "text-green-400" },
  transmit: { icon: Send, color: "text-red-400" },
  "catalog-editor": { icon: FileText, color: "text-blue-400" },
  "frame-calculator": { icon: Calculator, color: "text-teal-400" },
  "payload-analysis": { icon: GitCompare, color: "text-pink-400" },
  "frame-order-analysis": { icon: ListOrdered, color: "text-amber-400" },
  "serial-frame-analysis": { icon: Scan, color: "text-cyan-400" },
  query: { icon: DatabaseZap, color: "text-amber-400" },
  "session-manager": { icon: Network, color: "text-cyan-400" },
  settings: { icon: Settings, color: "text-orange-400" },
};

export default function AppTab(props: IDockviewPanelHeaderProps) {
  const { api } = props;
  const panelId = api.id as PanelId;
  const config = panelConfig[panelId];
  const [title, setTitle] = useState(api.title);
  const [isActive, setIsActive] = useState(api.isActive);

  // Listen for title and active state changes
  useEffect(() => {
    const disposables = [
      api.onDidTitleChange(() => setTitle(api.title)),
      api.onDidActiveChange(() => setIsActive(api.isActive)),
    ];
    return () => disposables.forEach((d) => d.dispose());
  }, [api]);

  const Icon = config?.icon;

  return (
    <div
      className={`dv-default-tab ${isActive ? "dv-active-tab" : ""}`}
      data-testid="dockview-tab"
    >
      <div className="dv-default-tab-content">
        {Icon && <Icon className={`${iconMd} flex-shrink-0 ${config.color}`} />}
        <span className="truncate">{title}</span>
      </div>
      <div className="dv-default-tab-action">
        <button
          className="dv-default-tab-action-button"
          onClick={(e) => {
            e.stopPropagation();
            api.close();
          }}
        >
          <X className={iconXs} />
        </button>
      </div>
    </div>
  );
}
