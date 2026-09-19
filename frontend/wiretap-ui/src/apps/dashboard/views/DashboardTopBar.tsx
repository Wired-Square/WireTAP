// ui/src/apps/dashboard/views/DashboardTopBar.tsx

import { Gauge, Plus, Save, Layout, X, AlertTriangle, Glasses, Sparkles, FlaskConical, Trash2, Wand2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import AppTopBar from "../../../components/AppTopBar";
import { iconSm, iconMd } from "../../../styles/spacing";
import { textSecondary } from "../../../styles/colourTokens";
import { useDashboardStore } from "../../../stores/dashboardStore";
import { useState, useRef, useEffect, Fragment } from "react";
import type { PanelType } from "../../../stores/dashboardStore";
import { WIDGET_LIST } from "../widgets/registry";
import { listDashboards, openDashboard, saveDashboard, type DashboardFile } from "../../../api/dashboards";
import { buildDashboard, parseDashboard, dashboardFilename } from "../../../utils/dashboards";
import { catalogFilenameFromPath } from "../../../utils/dashboardLayouts";
import type { DashboardLayout } from "../../../utils/dashboardLayouts";
import type { IOProfile } from "../../../types/common";
import type { CatalogMetadata } from "../../../api/catalog";
import { Button, IconButton } from "../../../components/Button";
import { Input } from "../../../components/forms";

/** Dropdown menu item style */
const menuItem = "w-full flex items-center gap-2 px-3 py-1.5 text-sm text-[color:var(--text-primary)] hover:bg-[var(--hover-bg)] transition-colors";

/** Dropdown menu container */
const menuContainer = "absolute top-full left-0 mt-1 py-1 min-w-[180px] bg-[var(--bg-surface)] border border-[var(--border-default)] rounded-lg shadow-xl z-50";

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

  // Add panel menu
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const addMenuRef = useRef<HTMLDivElement>(null);

  // Candidate signals menu
  const [candidateMenuOpen, setCandidateMenuOpen] = useState(false);
  const candidateMenuRef = useRef<HTMLDivElement>(null);

  // Layout menu
  const [layoutMenuOpen, setLayoutMenuOpen] = useState(false);
  const layoutMenuRef = useRef<HTMLDivElement>(null);
  const [saveName, setSaveName] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [dashboardFiles, setDashboardFiles] = useState<DashboardFile[]>([]);

  const refreshDashboardFiles = () => listDashboards().then(setDashboardFiles).catch(() => setDashboardFiles([]));
  useEffect(() => { if (layoutMenuOpen) refreshDashboardFiles(); }, [layoutMenuOpen]);

  const handleSaveDashboardFile = async () => {
    const name = saveName.trim();
    if (!name) return;
    const { panels, layout, catalogPath, candidateRegistry } = useDashboardStore.getState();
    const dashboard = buildDashboard(name, catalogFilenameFromPath(catalogPath), panels, layout, candidateRegistry, Date.now());
    await saveDashboard(dashboardFilename(name), JSON.stringify(dashboard, null, 2));
    setSaveName("");
    setIsSaving(false);
    setLayoutMenuOpen(false);
    refreshDashboardFiles();
  };

  const handleOpenDashboardFile = async (file: DashboardFile) => {
    const json = await openDashboard(file.path);
    useDashboardStore.getState().loadDashboard(parseDashboard(json));
    setLayoutMenuOpen(false);
  };

  // Close menus on outside click
  useEffect(() => {
    if (!addMenuOpen && !layoutMenuOpen && !candidateMenuOpen) return;
    const handler = (e: MouseEvent) => {
      if (addMenuOpen && addMenuRef.current && !addMenuRef.current.contains(e.target as Node)) {
        setAddMenuOpen(false);
      }
      if (layoutMenuOpen && layoutMenuRef.current && !layoutMenuRef.current.contains(e.target as Node)) {
        setLayoutMenuOpen(false);
        setIsSaving(false);
        setSaveName("");
      }
      if (candidateMenuOpen && candidateMenuRef.current && !candidateMenuRef.current.contains(e.target as Node)) {
        setCandidateMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [addMenuOpen, layoutMenuOpen, candidateMenuOpen]);

  const handleAddPanel = (type: PanelType) => {
    addPanel(type);
    setAddMenuOpen(false);
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
      icon={Gauge}
      iconColour="text-pink-400"
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
      <div ref={addMenuRef} className="relative">
        <IconButton
          onClick={() => setAddMenuOpen(!addMenuOpen)}
          variant="surface"
          title={t("topBar.addPanel")}
        >
          <Plus className={iconMd} />
        </IconButton>
        {addMenuOpen && (
          <div className={menuContainer}>
            {WIDGET_LIST.map((w, i) => {
              const Icon = w.icon;
              const newGroup = i > 0 && WIDGET_LIST[i - 1].category !== w.category;
              return (
                <Fragment key={w.type}>
                  {newGroup && <div className="my-1 border-t border-[var(--border-default)]" />}
                  <button onClick={() => handleAddPanel(w.type)} className={menuItem}>
                    <Icon className={iconSm} />
                    {t(w.displayName)}
                  </button>
                </Fragment>
              );
            })}
          </div>
        )}
      </div>

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
      <div ref={layoutMenuRef} className="relative">
        <IconButton
          onClick={() => {
            setLayoutMenuOpen(!layoutMenuOpen);
            setIsSaving(false);
            setSaveName("");
          }}
          variant="surface"
          title={t("topBar.manageLayouts")}
        >
          <Layout className={iconMd} />
        </IconButton>
        {layoutMenuOpen && (
          <div className={menuContainer} style={{ minWidth: 220 }}>
            {/* Save current layout */}
            {!isSaving ? (
              <button
                onClick={() => setIsSaving(true)}
                className={menuItem}
              >
                <Save className={iconSm} />
                {t("topBar.layouts.saveCurrent")}
              </button>
            ) : (
              <div className="flex items-center gap-1 px-3 py-1.5">
                <Input
                  type="text"
                  value={saveName}
                  onChange={(e) => setSaveName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleSaveLayout();
                    if (e.key === "Escape") { setIsSaving(false); setSaveName(""); }
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

            {/* Divider */}
            {savedLayouts.length > 0 && (
              <div className="border-t border-[var(--border-default)] my-1" />
            )}

            {/* Saved layouts list */}
            {savedLayouts.length === 0 && (
              <div className={`px-3 py-1.5 text-xs ${textSecondary}`}>
                {t("topBar.layouts.noLayouts")}
              </div>
            )}
            {savedLayouts.map((layout) => {
              const isMismatch = catalogFilename && layout.catalogFilename && layout.catalogFilename !== catalogFilename;
              return (
                <div
                  key={layout.id}
                  className="flex items-center gap-1 group"
                >
                  <button
                    onClick={() => {
                      onLoadLayout(layout);
                      setLayoutMenuOpen(false);
                    }}
                    className={`${menuItem} flex-1`}
                  >
                    {isMismatch && (
                      <span title={t("topBar.differentCatalog")}>
                        <AlertTriangle className="w-3 h-3 text-amber-400 shrink-0" />
                      </span>
                    )}
                    <span className="truncate flex-1 text-left">{layout.name}</span>
                    <span className="text-[10px] text-[color:var(--text-muted)] shrink-0 tabular-nums">
                      {t("topBar.panelsCount", { count: layout.panels.length })}
                    </span>
                  </button>
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
                <div className="border-t border-[var(--border-default)] my-1" />
                <div className={`px-3 py-1 text-[10px] font-medium ${textSecondary}`}>
                  {t("topBar.layouts.dashboardFiles")}
                </div>
                {dashboardFiles.map((file) => (
                  <button key={file.path} onClick={() => handleOpenDashboardFile(file)} className={`${menuItem} w-full`}>
                    <span className="truncate flex-1 text-left">{file.name}</span>
                  </button>
                ))}
              </>
            )}
          </div>
        )}
      </div>

      {/* Candidate signals dropdown */}
      {(onOpenCandidates || onOpenHypothesisExplorer) && (
        <div ref={candidateMenuRef} className="relative">
          <IconButton
            onClick={() => setCandidateMenuOpen(!candidateMenuOpen)}
            variant="surface"
            title={t("topBar.candidates")}
          >
            <Sparkles className={iconMd} />
          </IconButton>
          {candidateMenuOpen && (
            <div className={menuContainer}>
              {onOpenCandidates && (
                <button
                  onClick={() => {
                    setCandidateMenuOpen(false);
                    onOpenCandidates();
                  }}
                  className={menuItem}
                >
                  <Sparkles className={iconSm} />
                  {t("topBar.candidatesMenu.quick")}
                </button>
              )}
              {onOpenHypothesisExplorer && (
                <button
                  onClick={() => {
                    setCandidateMenuOpen(false);
                    onOpenHypothesisExplorer();
                  }}
                  className={menuItem}
                >
                  <FlaskConical className={iconSm} />
                  {t("topBar.candidatesMenu.hypothesis")}
                </button>
              )}
            </div>
          )}
        </div>
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
