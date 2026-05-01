// ui/src/apps/graph/views/panels/PanelWrapper.tsx

import { type ReactNode, useRef, useCallback, useEffect, useLayoutEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { Trash2, Settings2, Copy, Maximize2, ChevronsRight, BarChart2, Download, EllipsisVertical, Image, FileCode } from "lucide-react";
import { iconSm } from "../../../../styles/spacing";
import { iconButtonHover } from "../../../../styles/buttonStyles";
import { useGraphStore, type GraphPanel } from "../../../../stores/graphStore";

/** Menu-item toggle styling for active toggles in the dropdown. */
function menuToggle(isActive: boolean, colour: "blue" | "purple"): string {
  if (isActive) {
    return colour === "blue" ? "bg-blue-600/15 text-blue-400" : "bg-purple-600/15 text-purple-400";
  }
  return "";
}

/** Distance threshold (px) to distinguish a click from a drag. */
const DRAG_THRESHOLD = 5;

/** Delay (ms) before closing the menu after mouse leaves, allowing button→menu transition. */
const HOVER_CLOSE_DELAY = 150;

const menuClasses = "fixed py-1 min-w-[160px] bg-[var(--bg-surface)] border border-[var(--border-default)] rounded-lg shadow-xl z-[9999]";
const menuItem = "w-full flex items-center gap-2 px-3 py-1.5 text-xs text-[color:var(--text-primary)] hover:bg-[var(--hover-bg)] transition-colors cursor-pointer";
const menuDivider = "my-1 border-t border-[var(--border-default)]";

interface Props {
  panel: GraphPanel;
  onOpenPanelConfig: () => void;
  onExport?: () => void;
  onExportPng?: () => void;
  onExportSvg?: () => void;
  children: ReactNode;
}

export default function PanelWrapper({ panel, onOpenPanelConfig, onExport, onExportPng, onExportSvg, children }: Props) {
  const { t } = useTranslation("graph");
  const clonePanel = useGraphStore((s) => s.clonePanel);
  const removePanel = useGraphStore((s) => s.removePanel);
  const triggerZoomReset = useGraphStore((s) => s.triggerZoomReset);
  const setFollowMode = useGraphStore((s) => s.setFollowMode);
  const toggleStats = useGraphStore((s) => s.toggleStats);

  const hasTimeSeriesControls = panel.type === "line-chart" || panel.type === "flow";
  const followMode = panel.followMode !== false;

  // -- Hover menu state --
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuStyle, setMenuStyle] = useState<React.CSSProperties>({ visibility: "hidden" });
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Stash the button rect when hover begins so layout-effect can use it. */
  const buttonRectRef = useRef<DOMRect | null>(null);

  const cancelClose = useCallback(() => {
    if (closeTimer.current) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  }, []);

  const scheduleClose = useCallback(() => {
    cancelClose();
    closeTimer.current = setTimeout(() => setMenuOpen(false), HOVER_CLOSE_DELAY);
  }, [cancelClose]);

  const handleButtonEnter = useCallback(() => {
    cancelClose();
    if (!buttonRef.current) return;
    buttonRectRef.current = buttonRef.current.getBoundingClientRect();
    setMenuStyle({ visibility: "hidden" }); // reset until measured
    setMenuOpen(true);
  }, [cancelClose]);

  const handleMenuEnter = useCallback(() => cancelClose(), [cancelClose]);
  const handleMenuLeave = useCallback(() => scheduleClose(), [scheduleClose]);

  /** After the portal menu mounts, measure it and position within the viewport. */
  useLayoutEffect(() => {
    if (!menuOpen || !menuRef.current || !buttonRectRef.current) return;
    const menu = menuRef.current;
    const btnRect = buttonRectRef.current;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const mw = menu.offsetWidth;
    const mh = menu.offsetHeight;
    const gap = 2;

    // Vertical: prefer below button, flip above if it won't fit
    let top = btnRect.bottom + gap;
    if (top + mh > vh) top = btnRect.top - gap - mh;
    // Clamp to viewport
    top = Math.max(4, Math.min(top, vh - mh - 4));

    // Horizontal: align right edge to button right edge, push left if needed
    let left = btnRect.right - mw;
    if (left < 4) left = 4;
    if (left + mw > vw - 4) left = vw - 4 - mw;

    setMenuStyle({ top, left, visibility: "visible" });
  }, [menuOpen]);

  // Clean up timer on unmount
  useEffect(() => () => cancelClose(), [cancelClose]);

  // Track whether a drag-relocate occurred to suppress button clicks.
  // react-grid-layout uses mousemove-based dragging (not native HTML5 drag),
  // so we detect movement via document-level mousemove listeners.
  const mouseDownPos = useRef<{ x: number; y: number } | null>(null);
  const didDragRef = useRef(false);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    mouseDownPos.current = { x: e.clientX, y: e.clientY };
    didDragRef.current = false;
  }, []);

  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      if (!mouseDownPos.current || didDragRef.current) return;
      const dx = Math.abs(e.clientX - mouseDownPos.current.x);
      const dy = Math.abs(e.clientY - mouseDownPos.current.y);
      if (dx > DRAG_THRESHOLD || dy > DRAG_THRESHOLD) {
        didDragRef.current = true;
      }
    };
    const onMouseUp = () => {
      mouseDownPos.current = null;
    };
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
    return () => {
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
    };
  }, []);

  /** Capture-phase handler — suppresses all button clicks after a drag. */
  const handleClickCapture = useCallback((e: React.MouseEvent) => {
    if (didDragRef.current) {
      e.stopPropagation();
      e.preventDefault();
      didDragRef.current = false;
    }
  }, []);

  return (
    <div className="flex flex-col h-full bg-[var(--bg-surface)] border border-[var(--border-default)] rounded-lg overflow-hidden">
      {/* Header — drag handle with title and overflow menu */}
      <div
        className="drag-handle cursor-grab active:cursor-grabbing select-none border-b border-[var(--border-default)] bg-[var(--bg-primary)]"
        onMouseDown={handleMouseDown}
      >
        <div className="flex items-center px-2 py-0.5">
          <div className="flex-1 min-w-0 text-xs font-medium text-[color:var(--text-primary)] truncate">
            {panel.title}
          </div>

          {/* Overflow menu button — always visible */}
          <div
            className="shrink-0 ml-1"
            onMouseEnter={handleButtonEnter}
            onMouseLeave={scheduleClose}
            onClickCapture={handleClickCapture}
          >
            <button
              ref={buttonRef}
              className={`p-0.5 rounded ${iconButtonHover}`}
              title={t("panel.actions")}
            >
              <EllipsisVertical className={iconSm} />
            </button>
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 min-h-0 overflow-hidden">
        {children}
      </div>

      {/* Dropdown menu — rendered in portal to escape overflow clipping */}
      {menuOpen && createPortal(
        <div
          ref={menuRef}
          className={menuClasses}
          style={menuStyle}
          onMouseEnter={handleMenuEnter}
          onMouseLeave={handleMenuLeave}
          onClickCapture={handleClickCapture}
        >
          {/* Signal count */}
          {panel.signals.length > 0 && (
            <div className="px-3 py-1 text-[10px] font-medium text-[color:var(--text-muted)]">
              {t("panel.signalsCount", { count: panel.signals.length })}
            </div>
          )}

          {/* Time-series controls (line-chart + flow) */}
          {hasTimeSeriesControls && (
            <>
              <button
                onClick={() => setFollowMode(panel.id, !followMode)}
                className={`${menuItem} ${menuToggle(followMode, "blue")}`}
              >
                <ChevronsRight className={iconSm} />
                {followMode ? t("panel.following") : t("panel.followMode")}
              </button>
              <button
                onClick={() => toggleStats(panel.id)}
                className={`${menuItem} ${menuToggle(panel.showStats === true, "purple")}`}
              >
                <BarChart2 className={iconSm} />
                {panel.showStats ? t("panel.hideStats") : t("panel.showStats")}
              </button>
              <button onClick={triggerZoomReset} className={menuItem}>
                <Maximize2 className={iconSm} />
                {t("panel.resetZoom")}
              </button>
              <div className={menuDivider} />
            </>
          )}

          {/* Export */}
          {(onExport || onExportPng || onExportSvg) && (
            <>
              {onExportPng && (
                <button onClick={onExportPng} className={menuItem}>
                  <Image className={iconSm} />
                  {t("panel.exportPng")}
                </button>
              )}
              {onExportSvg && (
                <button onClick={onExportSvg} className={menuItem}>
                  <FileCode className={iconSm} />
                  {t("panel.exportSvg")}
                </button>
              )}
              {onExport && (
                <button onClick={onExport} className={menuItem}>
                  <Download className={iconSm} />
                  {t("panel.exportCsv")}
                </button>
              )}
              <div className={menuDivider} />
            </>
          )}

          {/* Configure */}
          <button onClick={onOpenPanelConfig} className={menuItem}>
            <Settings2 className={iconSm} />
            {t("panel.configure")}
          </button>

          {/* Clone */}
          <button onClick={() => clonePanel(panel.id)} className={menuItem}>
            <Copy className={iconSm} />
            {t("panel.clone")}
          </button>

          <div className={menuDivider} />

          {/* Remove */}
          <button onClick={() => removePanel(panel.id)} className={`${menuItem} text-red-400 hover:bg-red-500/10`}>
            <Trash2 className={iconSm} />
            {t("panel.remove")}
          </button>
        </div>,
        document.body,
      )}
    </div>
  );
}
