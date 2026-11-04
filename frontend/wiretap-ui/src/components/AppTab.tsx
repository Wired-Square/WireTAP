// ui/src/components/AppTab.tsx
// Custom Dockview tab component with the app's icon in its hue.

import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { type IDockviewPanelHeaderProps } from "dockview-react";
import { X } from "lucide-react";
import { iconMd, iconXs } from "../styles/spacing";
import { appTitle, isPanelId } from "../apps/registry";
import { AppIcon } from "./AppIcon";

export default function AppTab(props: IDockviewPanelHeaderProps) {
  const { api } = props;
  const panelId = api.id;
  const { t } = useTranslation();
  const [isActive, setIsActive] = useState(api.isActive);

  useEffect(() => {
    const disposable = api.onDidActiveChange(() => setIsActive(api.isActive));
    return () => disposable.dispose();
  }, [api]);

  return (
    <div
      className={`dv-default-tab ${isActive ? "dv-active-tab" : ""}`}
      data-testid="dockview-tab"
    >
      <div className="dv-default-tab-content">
        {isPanelId(panelId) && <AppIcon app={panelId} className={iconMd} />}
        <span className="truncate">{appTitle(t, panelId)}</span>
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
