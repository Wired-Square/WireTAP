// ui/src/apps/dashboard/views/panels/PanelWrapper.tsx

import { type ReactNode, useRef, useCallback, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Trash2, Settings2, Copy, Maximize2, ChevronsRight, BarChart2, Download, EllipsisVertical, Image, FileCode } from "lucide-react";
import { iconSm } from "../../../../styles/spacing";
import { useDashboardStore, type DashboardPanel } from "../../../../stores/dashboardStore";
import { getWidget } from "../../widgets/registry";
import { IconButton } from "../../../../components/Button";
import { Card } from "../../../../components/Card";
import { Menu, MenuHeading, MenuItem, MenuSeparator, usePopover } from "../../../../components/Menu";

/** Distance threshold (px) to distinguish a click from a drag. */
const DRAG_THRESHOLD = 5;

interface Props {
  panel: DashboardPanel;
  onOpenPanelConfig: () => void;
  onExport?: () => void;
  onExportPng?: () => void;
  onExportSvg?: () => void;
  children: ReactNode;
}

export default function PanelWrapper({ panel, onOpenPanelConfig, onExport, onExportPng, onExportSvg, children }: Props) {
  const { t } = useTranslation("dashboard");
  const clonePanel = useDashboardStore((s) => s.clonePanel);
  const removePanel = useDashboardStore((s) => s.removePanel);
  const triggerZoomReset = useDashboardStore((s) => s.triggerZoomReset);
  const setFollowMode = useDashboardStore((s) => s.setFollowMode);
  const toggleStats = useDashboardStore((s) => s.toggleStats);

  const hasTimeSeriesControls = getWidget(panel.type)?.dataShape === "timeseries";
  const followMode = panel.followMode !== false;

  const menu = usePopover();

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
    <Card padding="none" className="flex flex-col h-full overflow-hidden">
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
          <div className="shrink-0 ml-1" onClickCapture={handleClickCapture}>
            <IconButton {...menu.trigger} size="xs" title={t("panel.actions")}>
              <EllipsisVertical className={iconSm} />
            </IconButton>
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 min-h-0 overflow-hidden">
        {children}
      </div>

      <Menu {...menu.popover} align="end">
        {panel.signals.length > 0 && (
          <MenuHeading>{t("panel.signalsCount", { count: panel.signals.length })}</MenuHeading>
        )}

        {/* Time-series controls (line-chart + flow) */}
        {hasTimeSeriesControls && (
          <>
            <MenuItem onClick={() => setFollowMode(panel.id, !followMode)} checked={followMode} icon={<ChevronsRight />}>
              {followMode ? t("panel.following") : t("panel.followMode")}
            </MenuItem>
            <MenuItem onClick={() => toggleStats(panel.id)} checked={panel.showStats === true} icon={<BarChart2 />}>
              {panel.showStats ? t("panel.hideStats") : t("panel.showStats")}
            </MenuItem>
            <MenuItem onClick={triggerZoomReset} icon={<Maximize2 />}>
              {t("panel.resetZoom")}
            </MenuItem>
            <MenuSeparator />
          </>
        )}

        {/* Export */}
        {(onExport || onExportPng || onExportSvg) && (
          <>
            {onExportPng && (
              <MenuItem onClick={onExportPng} icon={<Image />}>
                {t("panel.exportPng")}
              </MenuItem>
            )}
            {onExportSvg && (
              <MenuItem onClick={onExportSvg} icon={<FileCode />}>
                {t("panel.exportSvg")}
              </MenuItem>
            )}
            {onExport && (
              <MenuItem onClick={onExport} icon={<Download />}>
                {t("panel.exportCsv")}
              </MenuItem>
            )}
            <MenuSeparator />
          </>
        )}

        <MenuItem onClick={onOpenPanelConfig} icon={<Settings2 />}>
          {t("panel.configure")}
        </MenuItem>
        <MenuItem onClick={() => clonePanel(panel.id)} icon={<Copy />}>
          {t("panel.clone")}
        </MenuItem>

        <MenuSeparator />

        <MenuItem onClick={() => removePanel(panel.id)} tone="danger" icon={<Trash2 />}>
          {t("panel.remove")}
        </MenuItem>
      </Menu>
    </Card>
  );
}
