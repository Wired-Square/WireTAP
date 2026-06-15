// ui/src/apps/graph/views/DashboardTopBar.tsx

import { Gauge, Plus, Save, Layout, X, AlertTriangle, Glasses, Sparkles, FlaskConical, Trash2, Wand2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import AppTopBar from "../../../components/AppTopBar";
import { iconButtonBase, iconButtonHoverDanger, toggleButtonClass } from "../../../styles/buttonStyles";
import { inputBase } from "../../../styles/inputStyles";
import { iconSm, iconMd } from "../../../styles/spacing";
import { textSecondary } from "../../../styles/colourTokens";
import { useGraphStore } from "../../../stores/graphStore";
import { useState, useRef, useEffect, Fragment } from "react";
import type { PanelType } from "../../../stores/graphStore";
import { WIDGET_LIST } from "../widgets/registry";
import { listDashboards, openDashboard, saveDashboard, type DashboardFile } from "../../../api/dashboards";
import { buildDashboard, parseDashboard, dashboardFilename } from "../../../utils/dashboards";
import { catalogFilenameFromPath } from "../../../utils/graphLayouts";
import type { GraphLayout } from "../../../utils/graphLayouts";
import type { IOProfile } from "../../../types/common";
import type { CatalogMetadata } from "../../../api/catalog";

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
  onOpenIoSessionPicker: () => void;

  // Catalog
  catalogs: CatalogMetadata[];
  catalogPath: string | null;
  onOpenCatalogPicker: () => void;

  // Watch state (for frame count display)
  isWatching: boolean;
  watchFrameCount: number;
  watchUniqueFrameCount?: number;

  // Layout persistence
  savedLayouts: GraphLayout[];
  onSaveLayout: (name: string) => Promise<void>;
  onLoadLayout: (layout: GraphLayout) => void;
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
  onOpenIoSessionPicker,
  catalogs,
  catalogPath,
  onOpenCatalogPicker,
  isWatching,
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
  const { t } = useTranslation("graph");
  const addPanel = useGraphStore((s) => s.addPanel);
  const removeAllPanels = useGraphStore((s) => s.removeAllPanels);
  const hasPanels = useGraphStore((s) => s.panels.length > 0);

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
    const { panels, layout, catalogPath, candidateRegistry } = useGraphStore.getState();
    const dashboard = buildDashboard(name, catalogFilenameFromPath(catalogPath), panels, layout, candidateRegistry, Date.now());
    await saveDashboard(dashboardFilename(name), JSON.stringify(dashboard, null, 2));
    setSaveName("");
    setIsSaving(false);
    setLayoutMenuOpen(false);
    refreshDashboardFiles();
  };

  const handleOpenDashboardFile = async (file: DashboardFile) => {
    const json = await openDashboard(file.path);
    useGraphStore.getState().loadDashboard(parseDashboard(json));
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
      }}
      catalog={{
        catalogs,
        catalogPath,
        onOpen: onOpenCatalogPicker,
      }}
      actions={
        isWatching && watchFrameCount > 0 ? (
          <span className={`text-xs ${textSecondary}`}>
            {t("topBar.framesCount", { count: watchFrameCount })}
          </span>
        ) : undefined
      }
    >
      {/* Add panel button with dropdown */}
      <div ref={addMenuRef} className="relative">
        <button
          onClick={() => setAddMenuOpen(!addMenuOpen)}
          className={iconButtonBase}
          title={t("topBar.addPanel")}
        >
          <Plus className={iconMd} />
        </button>
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
        <button
          onClick={onOpenInstruments}
          className={iconButtonBase}
          title={t("topBar.addInstruments")}
        >
          <Wand2 className={iconMd} />
        </button>
      )}

      {/* Layouts button with dropdown */}
      <div ref={layoutMenuRef} className="relative">
        <button
          onClick={() => {
            setLayoutMenuOpen(!layoutMenuOpen);
            setIsSaving(false);
            setSaveName("");
          }}
          className={iconButtonBase}
          title={t("topBar.manageLayouts")}
        >
          <Layout className={iconMd} />
        </button>
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
                <input
                  type="text"
                  value={saveName}
                  onChange={(e) => setSaveName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleSaveLayout();
                    if (e.key === "Escape") { setIsSaving(false); setSaveName(""); }
                  }}
                  placeholder={t("topBar.layouts.namePlaceholder")}
                  className={`${inputBase} flex-1 text-xs py-1`}
                  autoFocus
                />
                <button
                  onClick={handleSaveLayout}
                  disabled={!saveName.trim()}
                  className="text-xs px-2 py-1 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                  {t("topBar.layouts.save")}
                </button>
                <button
                  onClick={handleSaveDashboardFile}
                  disabled={!saveName.trim()}
                  title={t("topBar.layouts.saveFileHint")}
                  className="text-xs px-2 py-1 bg-[var(--bg-primary)] border border-[var(--border-default)] text-[color:var(--text-primary)] rounded hover:bg-[var(--hover-bg)] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                  {t("topBar.layouts.saveFile")}
                </button>
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
                  <button
                    onClick={(e) => handleDeleteLayout(e, layout.id)}
                    className={`${iconButtonHoverDanger} p-1 opacity-0 group-hover:opacity-100 shrink-0 mr-1`}
                    title={t("topBar.deleteLayout")}
                  >
                    <X className="w-3 h-3" />
                  </button>
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
          <button
            onClick={() => setCandidateMenuOpen(!candidateMenuOpen)}
            className={iconButtonBase}
            title={t("topBar.candidates")}
          >
            <Sparkles className={iconMd} />
          </button>
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
      <button
        onClick={onToggleRawView}
        title={rawViewMode ? t("topBar.switchToGrid") : t("topBar.switchToRaw")}
        className={toggleButtonClass(rawViewMode, "purple")}
      >
        <Glasses className={iconMd} fill={rawViewMode ? "currentColor" : "none"} />
      </button>

      {/* Remove all panels */}
      <button
        onClick={removeAllPanels}
        disabled={!hasPanels}
        className={`${iconButtonHoverDanger} disabled:opacity-30 disabled:cursor-not-allowed`}
        title={t("topBar.removeAll")}
      >
        <Trash2 className={iconMd} />
      </button>
    </AppTopBar>
  );
}
