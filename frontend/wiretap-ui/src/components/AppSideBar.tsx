// ui/src/components/AppSideBar.tsx
//
// Reusable collapsible sidebar component for apps like Settings.
// Renders a list of navigation items with icons and labels.

import { type LucideIcon, PanelLeftClose, PanelLeft } from "lucide-react";
import { iconLg, iconMd } from "../styles/spacing";
import {
  bgPrimary,
  borderDefault,
  bgInfo,
  textInfo,
  hoverLight,
  textSecondary,
  roundedDefault,
  gapSmall,
  spaceYSmall,
} from "../styles";

/**
 * A sidebar navigation item.
 */
export interface SideBarItem {
  /** Unique identifier for the item */
  id: string;
  /** Display label */
  label: string;
  /** Lucide icon component */
  icon: LucideIcon;
}

export interface AppSideBarProps {
  /** Navigation items to display */
  items: SideBarItem[];
  /** Currently active item ID */
  activeItem: string;
  /** Called when an item is selected */
  onSelect: (id: string) => void;
  /** Width class when expanded (default: "w-64") */
  width?: string;
  /** Whether the sidebar is collapsed */
  collapsed?: boolean;
  /** Called when collapse state changes */
  onToggleCollapsed?: () => void;
}

/**
 * Reusable collapsible sidebar component for apps.
 *
 * @example
 * ```tsx
 * const items: SideBarItem[] = [
 *   { id: 'general', label: 'General', icon: Cog },
 *   { id: 'display', label: 'Display', icon: Monitor },
 * ];
 *
 * <AppSideBar
 *   items={items}
 *   activeItem={currentSection}
 *   onSelect={setSection}
 *   collapsed={collapsed}
 *   onToggleCollapsed={() => setCollapsed(!collapsed)}
 * />
 * ```
 */
export default function AppSideBar({
  items,
  activeItem,
  onSelect,
  width = "w-64",
  collapsed = false,
  onToggleCollapsed,
}: AppSideBarProps) {
  const itemClasses = (id: string) =>
    `w-full flex items-center ${collapsed ? "justify-center" : ""} ${gapSmall} ${collapsed ? "px-2" : "px-4"} py-3 ${roundedDefault} transition-colors text-left ${
      activeItem === id
        ? `${bgInfo} ${textInfo}`
        : `${hoverLight} ${textSecondary}`
    }`;

  return (
    <aside
      className={`${collapsed ? "w-14" : width} ${bgPrimary} border-r ${borderDefault} flex flex-col overflow-hidden transition-all duration-200`}
    >
      {/* Collapse toggle button */}
      {onToggleCollapsed && (
        <div className={`flex ${collapsed ? "justify-center" : "justify-end"} p-2 border-b ${borderDefault}`}>
          <button
            onClick={onToggleCollapsed}
            className={`p-1.5 ${roundedDefault} ${hoverLight} ${textSecondary}`}
            title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          >
            {collapsed ? (
              <PanelLeft className={iconMd} />
            ) : (
              <PanelLeftClose className={iconMd} />
            )}
          </button>
        </div>
      )}

      <div className="flex-1 overflow-y-auto p-2">
        <nav className={spaceYSmall}>
          {items.map((item) => {
            const Icon = item.icon;
            return (
              <button
                key={item.id}
                onClick={() => onSelect(item.id)}
                className={itemClasses(item.id)}
                title={collapsed ? item.label : undefined}
              >
                <Icon className={iconLg} />
                {!collapsed && <span className="font-medium">{item.label}</span>}
              </button>
            );
          })}
        </nav>
      </div>
    </aside>
  );
}
