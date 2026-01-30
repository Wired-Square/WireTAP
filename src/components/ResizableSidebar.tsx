// ui/src/components/ResizableSidebar.tsx

import { useState, useRef, useCallback, useEffect, type ReactNode } from "react";
import { PanelLeftClose, PanelLeft } from "lucide-react";
import { iconMd } from "../styles/spacing";
import {
  hoverLight,
  bgPrimary,
  borderDefault,
  textSecondary,
  roundedDefault,
} from "../styles";

type Props = {
  children: ReactNode;
  defaultWidth?: number;
  minWidth?: number;
  maxWidth?: number;
  position?: "left" | "right";
  className?: string;
  collapsible?: boolean;
  /** Content to show when sidebar is collapsed (e.g., icon-only buttons) */
  collapsedContent?: ReactNode;
};

export default function ResizableSidebar({
  children,
  defaultWidth = 256,
  minWidth = 180,
  maxWidth = 500,
  position = "left",
  className = "",
  collapsible = false,
  collapsedContent,
}: Props) {
  const [width, setWidth] = useState(defaultWidth);
  const [isResizing, setIsResizing] = useState(false);
  const [isCollapsed, setIsCollapsed] = useState(false);
  const sidebarRef = useRef<HTMLDivElement>(null);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setIsResizing(true);
  }, []);

  const handleMouseMove = useCallback(
    (e: MouseEvent) => {
      if (!isResizing || !sidebarRef.current) return;

      const sidebarRect = sidebarRef.current.getBoundingClientRect();
      let newWidth: number;

      if (position === "left") {
        newWidth = e.clientX - sidebarRect.left;
      } else {
        newWidth = sidebarRect.right - e.clientX;
      }

      // Clamp to min/max
      newWidth = Math.max(minWidth, Math.min(maxWidth, newWidth));
      setWidth(newWidth);
    },
    [isResizing, minWidth, maxWidth, position]
  );

  const handleMouseUp = useCallback(() => {
    setIsResizing(false);
  }, []);

  // Add/remove global event listeners for drag
  useEffect(() => {
    if (isResizing) {
      document.addEventListener("mousemove", handleMouseMove);
      document.addEventListener("mouseup", handleMouseUp);
      // Add class to body to prevent text selection during resize
      document.body.style.userSelect = "none";
      document.body.style.cursor = "col-resize";
    } else {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
    }

    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
    };
  }, [isResizing, handleMouseMove, handleMouseUp]);

  const borderClass = position === "left" ? "border-r" : "border-l";
  const collapsedWidth = 56; // Match AppSideBar collapsed width (w-14 = 56px)

  const handleToggleCollapse = useCallback(() => {
    setIsCollapsed((prev) => !prev);
  }, []);

  return (
    <aside
      ref={sidebarRef}
      style={{ width: isCollapsed ? collapsedWidth : width }}
      className={`relative flex flex-col ${bgPrimary} ${borderClass} ${borderDefault} ${isResizing ? "" : "transition-[width] duration-200"} ${className}`}
    >
      {/* Header with collapse toggle - matches AppSideBar pattern */}
      {collapsible && (
        <div className={`flex ${isCollapsed ? "justify-center" : "justify-end"} p-2 border-b ${borderDefault}`}>
          <button
            onClick={handleToggleCollapse}
            className={`p-1.5 ${roundedDefault} ${hoverLight} ${textSecondary}`}
            title={isCollapsed ? "Expand sidebar" : "Collapse sidebar"}
          >
            {isCollapsed ? (
              <PanelLeft className={iconMd} />
            ) : (
              <PanelLeftClose className={iconMd} />
            )}
          </button>
        </div>
      )}

      {/* Content area */}
      {isCollapsed ? (
        // Collapsed content (e.g., icon-only buttons)
        collapsedContent && (
          <div className="flex flex-col items-center p-2 gap-2">
            {collapsedContent}
          </div>
        )
      ) : (
        <>
          <div className="flex-1 flex flex-col overflow-hidden">
            {children}
          </div>

          {/* Resize handle */}
          <div
            onMouseDown={handleMouseDown}
            className={`
              absolute top-0 bottom-0 w-1.5 z-10
              cursor-col-resize
              transition-colors duration-150
              hover:bg-blue-500/60
              ${isResizing ? "bg-blue-500/60" : "bg-transparent"}
              ${position === "left" ? "right-0 translate-x-1/2" : "left-0 -translate-x-1/2"}
            `}
          />
        </>
      )}
    </aside>
  );
}
