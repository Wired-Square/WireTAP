// ui/src/components/AppTab.tsx
// Custom Dockview tab component with the app's icon in its hue.

import { useState, useEffect } from "react";
import { type IDockviewPanelHeaderProps } from "dockview-react";
import { X } from "lucide-react";
import { iconMd, iconXs } from "../styles/spacing";
import { isPanelId } from "../apps/registry";
import { AppIcon } from "./AppIcon";

export default function AppTab(props: IDockviewPanelHeaderProps) {
  const { api } = props;
  const panelId = api.id;
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

  return (
    <div
      className={`dv-default-tab ${isActive ? "dv-active-tab" : ""}`}
      data-testid="dockview-tab"
    >
      <div className="dv-default-tab-content">
        {isPanelId(panelId) && <AppIcon app={panelId} className={iconMd} />}
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
