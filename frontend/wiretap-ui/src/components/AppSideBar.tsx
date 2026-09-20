// A collapsible side nav for an app with sections, like Settings: a vertical
// tab strip of icon-and-label rows, and a toggle that folds it to the icons.

import { type LucideIcon, PanelLeftClose, PanelLeft } from "lucide-react";
import { iconMd } from "../styles/spacing";
import { bgPrimary, borderDefault } from "../styles";
import { IconButton } from "./Button";
import { Tab, Tabs } from "./Tabs";

export interface SideBarItem {
  id: string;
  label: string;
  icon: LucideIcon;
}

export interface AppSideBarProps {
  items: SideBarItem[];
  activeItem: string;
  onSelect: (id: string) => void;
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
}

export default function AppSideBar({
  items,
  activeItem,
  onSelect,
  collapsed = false,
  onToggleCollapsed,
}: AppSideBarProps) {
  return (
    <aside
      className={`${collapsed ? "w-14" : "w-64"} ${bgPrimary} border-r ${borderDefault} flex flex-col overflow-hidden transition-all duration-200`}
    >
      {onToggleCollapsed && (
        <div className={`flex ${collapsed ? "justify-center" : "justify-end"} p-2 border-b ${borderDefault}`}>
          <IconButton
            onClick={onToggleCollapsed}
            size="sm"
            title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          >
            {collapsed ? (
              <PanelLeft className={iconMd} />
            ) : (
              <PanelLeftClose className={iconMd} />
            )}
          </IconButton>
        </div>
      )}

      <div className="flex-1 overflow-y-auto p-2">
        <Tabs orientation="vertical">
          {items.map((item) => {
            const Icon = item.icon;
            return (
              <Tab
                key={item.id}
                selected={activeItem === item.id}
                onClick={() => onSelect(item.id)}
                className={collapsed ? "justify-center px-2" : undefined}
                title={collapsed ? item.label : undefined}
              >
                <Icon />
                {!collapsed && <span>{item.label}</span>}
              </Tab>
            );
          })}
        </Tabs>
      </div>
    </aside>
  );
}
