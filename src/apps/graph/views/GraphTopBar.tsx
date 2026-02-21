// ui/src/apps/graph/views/GraphTopBar.tsx

import { BarChart3, Plus, LineChart, Gauge, List, Save, Layout, X, AlertTriangle, Glasses } from "lucide-react";
import AppTopBar from "../../../components/AppTopBar";
import { iconButtonBase, iconButtonHoverDanger, toggleButtonClass } from "../../../styles/buttonStyles";
import { inputBase } from "../../../styles/inputStyles";
import { iconSm, iconMd } from "../../../styles/spacing";
import { textSecondary } from "../../../styles/colourTokens";
import { useGraphStore } from "../../../stores/graphStore";
import { useState, useRef, useEffect } from "react";
import type { PanelType } from "../../../stores/graphStore";
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
  isStopped?: boolean;
  supportsTimeRange?: boolean;
  onStop?: () => void;
  onResume?: () => void;
  onLeave?: () => void;
  onOpenIoReaderPicker: () => void;

  // Catalog
  catalogs: CatalogMetadata[];
  catalogPath: string | null;
  defaultCatalogFilename?: string | null;
  onOpenCatalogPicker: () => void;

  // Watch state (for frame count display)
  isWatching: boolean;
  watchFrameCount: number;

  // Layout persistence
  savedLayouts: GraphLayout[];
  onSaveLayout: (name: string) => Promise<void>;
  onLoadLayout: (layout: GraphLayout) => void;
  onDeleteLayout: (id: string) => Promise<void>;
  catalogFilename: string;

  // Raw view mode
  rawViewMode: boolean;
  onToggleRawView: () => void;
}

export default function GraphTopBar({
  ioProfile,
  ioProfiles,
  multiBusProfiles,
  defaultReadProfileId,
  sessionId,
  ioState,
  isStreaming,
  isStopped,
  supportsTimeRange,
  onStop,
  onResume,
  onLeave,
  onOpenIoReaderPicker,
  catalogs,
  catalogPath,
  defaultCatalogFilename,
  onOpenCatalogPicker,
  isWatching,
  watchFrameCount,
  savedLayouts,
  onSaveLayout,
  onLoadLayout,
  onDeleteLayout,
  catalogFilename,
  rawViewMode,
  onToggleRawView,
}: Props) {
  const addPanel = useGraphStore((s) => s.addPanel);

  // Add panel menu
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const addMenuRef = useRef<HTMLDivElement>(null);

  // Layout menu
  const [layoutMenuOpen, setLayoutMenuOpen] = useState(false);
  const layoutMenuRef = useRef<HTMLDivElement>(null);
  const [saveName, setSaveName] = useState("");
  const [isSaving, setIsSaving] = useState(false);

  // Close menus on outside click
  useEffect(() => {
    if (!addMenuOpen && !layoutMenuOpen) return;
    const handler = (e: MouseEvent) => {
      if (addMenuOpen && addMenuRef.current && !addMenuRef.current.contains(e.target as Node)) {
        setAddMenuOpen(false);
      }
      if (layoutMenuOpen && layoutMenuRef.current && !layoutMenuRef.current.contains(e.target as Node)) {
        setLayoutMenuOpen(false);
        setIsSaving(false);
        setSaveName("");
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [addMenuOpen, layoutMenuOpen]);

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
      icon={BarChart3}
      iconColour="text-pink-400"
      ioSession={{
        ioProfile,
        ioProfiles,
        multiBusProfiles,
        defaultReadProfileId,
        sessionId,
        ioState,
        onOpenIoReaderPicker,
        isStreaming,
        isStopped,
        supportsTimeRange,
        onStop,
        onResume,
        onLeave,
      }}
      catalog={{
        catalogs,
        catalogPath,
        defaultCatalogFilename,
        onOpen: onOpenCatalogPicker,
      }}
      actions={
        isWatching && watchFrameCount > 0 ? (
          <span className={`text-xs ${textSecondary}`}>
            {watchFrameCount.toLocaleString()} frames
          </span>
        ) : undefined
      }
    >
      {/* Add panel button with dropdown */}
      <div ref={addMenuRef} className="relative">
        <button
          onClick={() => setAddMenuOpen(!addMenuOpen)}
          className={iconButtonBase}
          title="Add panel"
        >
          <Plus className={iconMd} />
        </button>
        {addMenuOpen && (
          <div className={menuContainer}>
            <button onClick={() => handleAddPanel('line-chart')} className={menuItem}>
              <LineChart className={iconSm} />
              Line Chart
            </button>
            <button onClick={() => handleAddPanel('gauge')} className={menuItem}>
              <Gauge className={iconSm} />
              Gauge
            </button>
            <button onClick={() => handleAddPanel('list')} className={menuItem}>
              <List className={iconSm} />
              List
            </button>
          </div>
        )}
      </div>

      {/* Layouts button with dropdown */}
      <div ref={layoutMenuRef} className="relative">
        <button
          onClick={() => {
            setLayoutMenuOpen(!layoutMenuOpen);
            setIsSaving(false);
            setSaveName("");
          }}
          className={iconButtonBase}
          title="Manage layouts"
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
                Save Current Layout
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
                  placeholder="Layout name"
                  className={`${inputBase} flex-1 text-xs py-1`}
                  autoFocus
                />
                <button
                  onClick={handleSaveLayout}
                  disabled={!saveName.trim()}
                  className="text-xs px-2 py-1 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                  Save
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
                No saved layouts
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
                      <span title="Different catalog">
                        <AlertTriangle className="w-3 h-3 text-amber-400 shrink-0" />
                      </span>
                    )}
                    <span className="truncate flex-1 text-left">{layout.name}</span>
                    <span className="text-[10px] text-[color:var(--text-muted)] shrink-0 tabular-nums">
                      {layout.panels.length}p
                    </span>
                  </button>
                  <button
                    onClick={(e) => handleDeleteLayout(e, layout.id)}
                    className={`${iconButtonHoverDanger} p-1 opacity-0 group-hover:opacity-100 shrink-0 mr-1`}
                    title="Delete layout"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Raw view toggle */}
      <button
        onClick={onToggleRawView}
        title={rawViewMode ? "Switch to Grid View" : "Switch to Raw JSON View"}
        className={toggleButtonClass(rawViewMode, "purple")}
      >
        <Glasses className={iconMd} fill={rawViewMode ? "currentColor" : "none"} />
      </button>
    </AppTopBar>
  );
}
