// ui/src/apps/dashboard/views/DashboardTopBar.tsx

import { Plus, Save, Layout, X, AlertTriangle, Glasses, Sparkles, FlaskConical, Trash2, Wand2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import AppTopBar from "../../../components/AppTopBar";
import { iconMd } from "../../../styles/spacing";
import { textSecondary } from "../../../styles/colourTokens";
import { useDashboardStore } from "../../../stores/dashboardStore";
import { useState, useEffect, Fragment } from "react";
import { WIDGET_LIST } from "../widgets/registry";
import { listDashboards, openDashboard, saveDashboard, type DashboardFile } from "../../../api/dashboards";
import { buildDashboard, parseDashboard, dashboardFilename } from "../../../utils/dashboards";
import { catalogFilenameFromPath } from "../../../utils/dashboardLayouts";
import type { DashboardLayout } from "../../../utils/dashboardLayouts";
import type { IOProfile } from "../../../types/common";
import type { CatalogMetadata } from "../../../api/catalog";
import { Button, IconButton } from "../../../components/Button";
import { Input } from "../../../components/forms";
import { Menu, MenuHeading, MenuItem, MenuSeparator, usePopover } from "../../../components/Menu";

interface Props {
  // IO session
  ioProfile: string | null;
  ioProfiles: IOProfile[];
  multiBusProfiles?: string[];
  defaultReadProfileId?: string | null;
  sessionId?: string | null;
  ioState?: string | null;
  isStreaming: boolean;
  isPaused?: boolean;
  isStopped?: boolean;
  supportsTimeRange?: boolean;
  onPlay?: () => void;
  onPause?: () => void;
  onLeave?: () => void;
  onStop?: () => void;
  onDestroy?: () => void;
  onOpenIoSessionPicker: () => void;

  // Catalog
  catalogs: CatalogMetadata[];
  catalogPath: string | null;
  onOpenCatalogPicker: () => void;

  // Frame counts (kebab-menu session details)
  watchFrameCount: number;
  watchUniqueFrameCount?: number;

  // Layout persistence
  savedLayouts: DashboardLayout[];
  onSaveLayout: (name: string) => Promise<void>;
  onLoadLayout: (layout: DashboardLayout) => void;
  onDeleteLayout: (id: string) => Promise<void>;
  catalogFilename: string;

  // Raw view mode
  rawViewMode: boolean;
  onToggleRawView: () => void;

  // Candidate signals
  onOpenCandidates?: () => void;
  onOpenHypothesisExplorer?: () => void;

  // Auto-instruments from catalog signals
  onOpenInstruments?: () => void;
}

export default function DashboardTopBar({
  ioProfile,
  ioProfiles,
  multiBusProfiles,
  defaultReadProfileId,
  sessionId,
  ioState,
  isStreaming,
  isPaused,
  isStopped,
  supportsTimeRange,
  onPlay,
  onPause,
  onLeave,
  onStop,
  onDestroy,
  onOpenIoSessionPicker,
  catalogs,
  catalogPath,
  onOpenCatalogPicker,
  watchFrameCount,
  watchUniqueFrameCount,
  savedLayouts,
  onSaveLayout,
  onLoadLayout,
  onDeleteLayout,
  catalogFilename,
  rawViewMode,
  onToggleRawView,
  onOpenCandidates,
  onOpenHypothesisExplorer,
  onOpenInstruments,
}: Props) {
  const { t } = useTranslation("dashboard");
  const addPanel = useDashboardStore((s) => s.addPanel);
  const removeAllPanels = useDashboardStore((s) => s.removeAllPanels);
  const hasPanels = useDashboardStore((s) => s.panels.length > 0);

  const addMenu = usePopover();
  const candidateMenu = usePopover();
  const layoutMenu = usePopover();
  const [saveName, setSaveName] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [dashboardFiles, setDashboardFiles] = useState<DashboardFile[]>([]);

  const refreshDashboardFiles = () => listDashboards().then(setDashboardFiles).catch(() => setDashboardFiles([]));
  useEffect(() => { if (layoutMenu.open) refreshDashboardFiles(); }, [layoutMenu.open]);

  const closeLayoutMenu = () => {
    layoutMenu.close();
    setIsSaving(false);
    setSaveName("");
  };

  const handleSaveDashboardFile = async () => {
    const name = saveName.trim();
    if (!name) return;
    const { panels, layout, catalogPath, candidateRegistry } = useDashboardStore.getState();
    const dashboard = buildDashboard(name, catalogFilenameFromPath(catalogPath), panels, layout, candidateRegistry, Date.now());
    await saveDashboard(dashboardFilename(name), JSON.stringify(dashboard, null, 2));
    closeLayoutMenu();
    refreshDashboardFiles();
  };

  const handleOpenDashboardFile = async (file: DashboardFile) => {
    const json = await openDashboard(file.path);
    useDashboardStore.getState().loadDashboard(parseDashboard(json));
    closeLayoutMenu();
  };

  const handleSaveLayout = async () => {
    const name = saveName.trim();
    if (!name) return;
    await onSaveLayout(name);
    setSaveName("");
    setIsSaving(false);
  };

  const handleDeleteLayout = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    await onDeleteLayout(id);
  };

  return (
    <AppTopBar
      app="dashboard"
      frameIdFormat
      ioSession={{
        ioProfile,
        ioProfiles,
        multiBusProfiles,
        defaultReadProfileId,
        sessionId,
        ioState,
        frameCount: watchUniqueFrameCount,
        totalFrameCount: watchFrameCount,
        onOpenIoSessionPicker,
        isStreaming,
        isPaused,
        isStopped,
        supportsTimeRange,
        onPlay,
        onPause,
        onLeave,
        onStop,
        onDestroy,
      }}
      catalog={{
        catalogs,
        catalogPath,
        onOpen: onOpenCatalogPicker,
      }}
    >
      {/* Add panel button with dropdown */}
      <IconButton {...addMenu.trigger} variant="surface" title={t("topBar.addPanel")}>
        <Plus className={iconMd} />
      </IconButton>
      <Menu {...addMenu.popover}>
        {WIDGET_LIST.map((w, i) => {
          const Icon = w.icon;
          const newGroup = i > 0 && WIDGET_LIST[i - 1].category !== w.category;
          return (
            <Fragment key={w.type}>
              {newGroup && <MenuSeparator />}
              <MenuItem onClick={() => addPanel(w.type)} icon={<Icon />}>
                {t(w.displayName)}
              </MenuItem>
            </Fragment>
          );
        })}
      </Menu>

      {/* Auto-add catalog signals as pre-configured instruments */}
      {onOpenInstruments && (
        <IconButton
          onClick={onOpenInstruments}
          variant="surface"
          title={t("topBar.addInstruments")}
        >
          <Wand2 className={iconMd} />
        </IconButton>
      )}

      {/* Layouts button with dropdown */}
      <IconButton
        {...layoutMenu.trigger}
        onClick={() => (layoutMenu.open ? closeLayoutMenu() : layoutMenu.toggle())}
        variant="surface"
        title={t("topBar.manageLayouts")}
      >
        <Layout className={iconMd} />
      </IconButton>
      <Menu {...layoutMenu.popover} onClose={closeLayoutMenu} className="min-w-[220px]">
        {/* Save current layout */}
        {!isSaving ? (
          <MenuItem onClick={() => setIsSaving(true)} keepOpen icon={<Save />}>
            {t("topBar.layouts.saveCurrent")}
          </MenuItem>
        ) : (
          <div className="flex items-center gap-1 px-3 py-1.5">
            <Input
              type="text"
              value={saveName}
              onChange={(e) => setSaveName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleSaveLayout();
                if (e.key === "Escape") { e.preventDefault(); setIsSaving(false); setSaveName(""); }
              }}
              placeholder={t("topBar.layouts.namePlaceholder")}
              size="sm"
              className="flex-1"
              autoFocus
            />
            <Button
              onClick={handleSaveLayout}
              disabled={!saveName.trim()}
              variant="solid"
              tone="primary"
              size="sm"
            >
              {t("topBar.layouts.save")}
            </Button>
            <Button
              onClick={handleSaveDashboardFile}
              disabled={!saveName.trim()}
              title={t("topBar.layouts.saveFileHint")}
              variant="outline"
              size="sm"
            >
              {t("topBar.layouts.saveFile")}
            </Button>
          </div>
        )}

        {savedLayouts.length > 0 && <MenuSeparator />}

        {/* Saved layouts list */}
        {savedLayouts.length === 0 && (
          <div className={`px-3 py-1.5 ${textSecondary}`}>
            {t("topBar.layouts.noLayouts")}
          </div>
        )}
        {savedLayouts.map((layout) => {
          const isMismatch = catalogFilename && layout.catalogFilename && layout.catalogFilename !== catalogFilename;
          return (
            <div key={layout.id} className="flex items-center gap-1 group">
              <MenuItem
                onClick={() => onLoadLayout(layout)}
                className="flex-1"
                icon={
                  isMismatch ? (
                    <span title={t("topBar.differentCatalog")}>
                      <AlertTriangle className="text-amber-400" />
                    </span>
                  ) : undefined
                }
              >
                <span className="truncate flex-1">{layout.name}</span>
                <span className="text-[10px] text-[color:var(--text-muted)] shrink-0 tabular-nums">
                  {t("topBar.panelsCount", { count: layout.panels.length })}
                </span>
              </MenuItem>
              <IconButton
                onClick={(e) => handleDeleteLayout(e, layout.id)}
                tone="danger"
                size="xs"
                className="opacity-0 group-hover:opacity-100 mr-1"
                title={t("topBar.deleteLayout")}
              >
                <X className="w-3 h-3" />
              </IconButton>
            </div>
          );
        })}

        {/* Dashboard files (shareable *.dashboard.json) */}
        {dashboardFiles.length > 0 && (
          <>
            <MenuSeparator />
            <MenuHeading>{t("topBar.layouts.dashboardFiles")}</MenuHeading>
            {dashboardFiles.map((file) => (
              <MenuItem key={file.path} onClick={() => handleOpenDashboardFile(file)}>
                <span className="truncate flex-1">{file.name}</span>
              </MenuItem>
            ))}
          </>
        )}
      </Menu>

      {/* Candidate signals dropdown */}
      {(onOpenCandidates || onOpenHypothesisExplorer) && (
        <>
          <IconButton {...candidateMenu.trigger} variant="surface" title={t("topBar.candidates")}>
            <Sparkles className={iconMd} />
          </IconButton>
          <Menu {...candidateMenu.popover}>
            {onOpenCandidates && (
              <MenuItem onClick={onOpenCandidates} icon={<Sparkles />}>
                {t("topBar.candidatesMenu.quick")}
              </MenuItem>
            )}
            {onOpenHypothesisExplorer && (
              <MenuItem onClick={onOpenHypothesisExplorer} icon={<FlaskConical />}>
                {t("topBar.candidatesMenu.hypothesis")}
              </MenuItem>
            )}
          </Menu>
        </>
      )}

      {/* Raw view toggle */}
      <IconButton
        onClick={onToggleRawView}
        title={rawViewMode ? t("topBar.switchToGrid") : t("topBar.switchToRaw")}
        variant="surface"
        tone="purple"
        pressed={rawViewMode}
      >
        <Glasses className={iconMd} fill={rawViewMode ? "currentColor" : "none"} />
      </IconButton>

      {/* Remove all panels */}
      <IconButton
        onClick={removeAllPanels}
        disabled={!hasPanels}
        tone="danger"
        title={t("topBar.removeAll")}
      >
        <Trash2 className={iconMd} />
      </IconButton>
    </AppTopBar>
  );
}
