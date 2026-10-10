// ui/src/stores/dashboardStore.ts

import { create } from 'zustand';
import { tlog } from '../api/settings';
import type { Confidence } from '../types/catalog';
import type { Catalog, Frame } from '../types/catalogModel';
import { attachCatalog, openCatalog, parseCatalogAtPath } from '../api/catalog';
import { allFrameSignals, framesById } from '../utils/catalogFrames';
import { subscriberIdFor } from '../utils/subscriberId';

import { serialFrameConfigOf, type SerialFrameConfig } from '../utils/frameExport';
import {
  getAllDashboardLayouts,
  saveDashboardLayout,
  deleteDashboardLayout,
  catalogFilenameFromPath,
  type DashboardLayout,
} from '../utils/dashboardLayouts';
import { storeGet, storeSet, storeDelete } from '../api/store';
import { WIDGET_META } from '../apps/dashboard/widgets/widgetMeta';
import type { WidgetConfig } from '../apps/dashboard/widgets/configTypes';
import { widgetForSignal } from '../apps/dashboard/widgets/autoWidget';
import type { DashboardFileContent } from '../utils/dashboards';
import { BYTE_NAMES } from '../generated/byteNames';

// ─────────────────────────────────────────
// Types
// ─────────────────────────────────────────

/** Type of visualisation panel */
export type PanelType =
  | 'line-chart' | 'gauge' | 'list' | 'flow' | 'heatmap' | 'histogram'
  | 'icon-state' | 'rotary' | 'level-bar' | 'bitfield' | 'raw-canvas' | 'custom-svg';

/** One colour per series, in panel order: signal lines and flow bytes alike. */
export const SERIES_COLOURS = [
  '#3b82f6', // blue
  '#ef4444', // red
  '#22c55e', // green
  '#f59e0b', // amber
  '#a855f7', // purple
  '#06b6d4', // cyan
  '#f97316', // orange
  '#ec4899', // pink
];

/** A signal reference (frame ID + signal name uniquely identify a signal) */
export interface SignalRef {
  frameId: number;
  signalName: string;
  unit?: string;
  colour: string;
  displayName?: string;
  confidence?: Confidence;
  /** Which Y-axis this signal is plotted on (line-chart only). Default: 'left'. */
  yAxis?: 'left' | 'right';
}

/** The key a signal's latest value is held under, and a custom widget names it by. */
export function signalKey(frameId: number, signalName: string): string {
  return `${frameId}:${signalName}`;
}

/** A flow panel's byte columns on its target frame. */
export function flowSignals(panel: Pick<DashboardPanel, 'targetFrameId' | 'byteCount'>): SignalRef[] {
  if (panel.targetFrameId == null) return [];
  return Array.from({ length: panel.byteCount ?? 8 }, (_, i) => ({
    frameId: panel.targetFrameId!,
    signalName: BYTE_NAMES[i],
    colour: SERIES_COLOURS[i % SERIES_COLOURS.length],
  }));
}

/** Get the display label for a signal (friendly name if set, otherwise raw signal name) */
export function getSignalLabel(signal: SignalRef): string {
  return signal.displayName || signal.signalName;
}

/** Get the confidence colour from settings */
export function getConfidenceColour(
  confidence: Confidence | undefined,
  settings: { signal_colour_none?: string; signal_colour_low?: string; signal_colour_medium?: string; signal_colour_high?: string } | null,
): string {
  if (!settings) return '#94a3b8';
  switch (confidence) {
    case 'high': return settings.signal_colour_high || '#22c55e';
    case 'medium': return settings.signal_colour_medium || '#3b82f6';
    case 'low': return settings.signal_colour_low || '#f59e0b';
    case 'none':
    default: return settings.signal_colour_none || '#94a3b8';
  }
}

/** A panel definition stored in the layout */
export interface DashboardPanel {
  id: string;
  type: PanelType;
  title: string;
  signals: SignalRef[];
  // Gauge-specific
  minValue: number;
  maxValue: number;
  /** Which signal to show as the primary gauge reading (index into signals array) */
  primarySignalIndex?: number;
  /** Whether the chart auto-scrolls to follow the latest data (line-chart/flow only). Default: true. */
  followMode?: boolean;
  /** Whether to show the statistics overlay (line-chart/flow only). Default: false. */
  showStats?: boolean;
  /** Flow/heatmap: the CAN frame ID to plot raw bytes for */
  targetFrameId?: number;
  /** Flow: number of bytes to plot (auto-detected from incoming frames, default 8) */
  byteCount?: number;
  /** Histogram: number of bins (default 20) */
  histogramBins?: number;
  /** Per-widget config; shape depends on panel.type (see widget definitions). */
  widgetConfig?: WidgetConfig;
}

/** react-grid-layout layout item */
export interface LayoutItem {
  i: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Parameters for a hypothesis candidate signal */
export interface HypothesisParams {
  /** Bit-level start offset within the frame payload */
  startBit: number;
  /** Number of bits to extract */
  bitLength: number;
  /** Endianness for extraction */
  endianness: 'little' | 'big';
  /** Whether the extracted value is signed */
  signed: boolean;
  /** Scale factor: physicalValue = rawValue * factor + offset */
  factor: number;
  /** Offset: physicalValue = rawValue * factor + offset */
  offset: number;
}

// ─────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────

let panelCounter = 0;
function generatePanelId(): string {
  return `panel_${Date.now()}_${panelCounter++}`;
}

function signalConfidence(frame: Frame | undefined, name: string): Confidence | undefined {
  return frame && allFrameSignals(frame).find((s) => s.name === name && s.confidence)?.confidence;
}

/** Auto-save store key */
const AUTO_SAVE_KEY = 'graph.lastSession';
const AUTO_SAVE_DEBOUNCE_MS = 2000;
let autoSaveTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleAutoSave() {
  if (autoSaveTimer) clearTimeout(autoSaveTimer);
  autoSaveTimer = setTimeout(async () => {
    const { panels, layout, catalogPath, candidateRegistry } = useDashboardStore.getState();
    if (panels.length > 0) {
      await storeSet(AUTO_SAVE_KEY, {
        catalogFilename: catalogFilenameFromPath(catalogPath),
        panels,
        layout,
        candidateRegistry: Array.from(candidateRegistry.entries()),
        savedAt: Date.now(),
      });
    }
  }, AUTO_SAVE_DEBOUNCE_MS);
}

// ─────────────────────────────────────────
// Store
// ─────────────────────────────────────────

interface DashboardState {
  // ── Catalog ──
  catalogPath: string | null;
  frames: Map<number, Frame>;
  protocol: 'can' | 'serial' | 'modbus';
  serialConfig: SerialFrameConfig | null;

  // ── IO Session ──
  /** The session whose history the panels read. */
  sessionId: string | null;
  ioProfile: string | null;
  playbackSpeed: number;

  // ── Panels & Layout ──
  panels: DashboardPanel[];
  layout: LayoutItem[];

  // ── Signal data (the history is Rust's) ──
  /** The last value each signal key arrived with, for the instruments. */
  latest: Map<string, number>;
  /** Bumped per delivery: charts re-read the history when it changes. */
  dataVersion: number;

  // ── Chart interaction ──
  /** Monotonically increasing counter — line charts reset zoom when this changes */
  zoomResetVersion: number;

  // ── Raw byte tracking (flow view / heatmap) ──
  /** Frame IDs seen during the current session (for flow/heatmap frame pickers) */
  discoveredFrameIds: Set<number>;
  /** Heatmap bit-toggle counts from Rust, by frame id; index `byte * 8 + bit`. */
  bitChangeCounts: Map<number, { counts: number[]; totalFrames: number }>;

  /** Registry of hypothesis signal parameters, keyed by hyp_* signal name */
  candidateRegistry: Map<string, HypothesisParams>;

  // ── Actions ──
  /** Parse-only load (no session bind). */
  loadCatalog: (path: string) => Promise<void>;
  /** Attach to a session for Rust decode AND load the model from that one parse. */
  loadCatalogForSession: (sessionId: string, path: string) => Promise<void>;
  /** Build the in-memory model from an already-resolved catalogue. */
  applyCatalog: (catalog: Catalog) => void;
  /** Track the active catalogue path without parsing. */
  setCatalogPath: (path: string | null) => void;
  initFromSettings: (decoderDir?: string) => Promise<void>;
  setSessionId: (sessionId: string | null) => void;
  setIoProfile: (profile: string | null) => void;
  setPlaybackSpeed: (speed: number) => void;

  // Panel management
  addPanel: (type: PanelType) => string;
  /** Add each signal as its own pre-configured instrument panel (display hint → widget). */
  addSignalsAsInstruments: (signals: Array<{ frameId: number; signalName: string; unit?: string }>) => void;
  clonePanel: (panelId: string) => void;
  removePanel: (panelId: string) => void;
  removeAllPanels: () => void;
  updatePanel: (panelId: string, updates: Partial<Pick<DashboardPanel, 'title' | 'minValue' | 'maxValue' | 'primarySignalIndex' | 'targetFrameId' | 'byteCount' | 'histogramBins' | 'widgetConfig' | 'signals'>>) => void;
  addSignalToPanel: (panelId: string, frameId: number, signalName: string, unit?: string) => void;
  removeSignalFromPanel: (panelId: string, frameId: number, signalName: string) => void;
  updateSignalColour: (panelId: string, frameId: number, signalName: string, colour: string) => void;
  updateSignalDisplayName: (panelId: string, frameId: number, signalName: string, displayName: string) => void;
  updateSignalYAxis: (panelId: string, frameId: number, signalName: string, yAxis: 'left' | 'right') => void;
  reorderSignals: (panelId: string, fromIndex: number, toIndex: number) => void;
  replaceSignalSource: (panelId: string, oldFrameId: number, oldSignalName: string, newFrameId: number, newSignalName: string, newUnit?: string) => void;
  updateLayout: (layout: LayoutItem[]) => void;
  setFollowMode: (panelId: string, follow: boolean) => void;
  toggleStats: (panelId: string) => void;
  triggerZoomReset: () => void;

  // Layout persistence
  savedLayouts: DashboardLayout[];
  loadSavedLayouts: () => Promise<void>;
  saveCurrentLayout: (name: string) => Promise<void>;
  loadLayout: (layout: DashboardLayout) => void;
  /** Load a standalone dashboard artifact (same set as loadLayout). */
  loadDashboard: (dashboard: DashboardFileContent) => void;
  deleteSavedLayout: (id: string) => Promise<void>;
  restoreLastSession: () => Promise<void>;

  // Data ingestion
  setLatest: (values: Map<string, number>) => void;
  clearData: () => void;

  // Raw byte tracking (flow view / heatmap)
  recordFrameId: (frameId: number) => void;
  setBitToggles: (toggles: { frameId: number; counts: number[]; frames: number }[]) => void;

  // Hypothesis candidate registry
  registerHypotheses: (entries: Array<{ signalName: string; params: HypothesisParams }>) => void;
  clearHypothesisRegistry: () => void;
}

export const useDashboardStore = create<DashboardState>((set, get) => ({
  // ── Initial state ──
  catalogPath: null,
  frames: new Map(),
  protocol: 'can',
  serialConfig: null,

  sessionId: null,
  ioProfile: null,
  playbackSpeed: 1,

  panels: [],
  layout: [],
  savedLayouts: [],

  latest: new Map(),
  dataVersion: 0,
  zoomResetVersion: 0,
  discoveredFrameIds: new Set(),
  bitChangeCounts: new Map(),
  candidateRegistry: new Map(),

  // ── Actions ──

  loadCatalog: async (path: string) => {
    get().applyCatalog(await parseCatalogAtPath(path));
  },

  loadCatalogForSession: async (sessionId: string, path: string) => {
    try {
      const { catalog } = await attachCatalog(sessionId, await openCatalog(path), path, subscriberIdFor("dashboard"));
      get().applyCatalog(catalog);
    } catch (e) {
      tlog.info(`[dashboardStore] catalog attach failed, loading model only: ${e}`);
      await get().loadCatalog(path);
    }
  },

  setCatalogPath: (path: string | null) => set({ catalogPath: path }),

  // Apply a parsed catalogue to the dashboard's decode model. The catalogue PATH is
  // owned by the session (Rust-authoritative, mirrored one-way via useSessionCatalog) —
  // this must NOT write `catalogPath`, or it races the mirror into a reload loop.
  applyCatalog: (catalog: Catalog) => {
    set({
      frames: framesById(catalog),
      protocol: catalog.protocol,
      serialConfig: catalog.serial ? serialFrameConfigOf(catalog.serial) : null,
    });
  },

  initFromSettings: async (_decoderDir) => {
    // Restore panels from last session
    await get().restoreLastSession();
  },

  setSessionId: (sessionId) => set({ sessionId }),
  setIoProfile: (profile) => set({ ioProfile: profile }),
  setPlaybackSpeed: (speed) => set({ playbackSpeed: speed }),

  // ── Panel management ──

  addPanel: (type) => {
    const id = generatePanelId();
    const { panels, layout } = get();

    // Find the next available Y position
    const maxY = layout.reduce((max, item) => Math.max(max, item.y + item.h), 0);

    const meta = WIDGET_META[type];

    const newPanel: DashboardPanel = {
      id,
      type,
      title: meta?.defaultConfig.title ?? 'Panel',
      signals: [],
      minValue: 0,
      maxValue: 100,
      ...meta?.defaultConfig,
    };

    const newLayoutItem: LayoutItem = {
      i: id,
      x: 0,
      y: maxY,
      ...(meta?.defaultSize ?? { w: 4, h: 3 }),
    };

    set({
      panels: [...panels, newPanel],
      layout: [...layout, newLayoutItem],
    });
    scheduleAutoSave();
    return id;
  },

  addSignalsAsInstruments: (entries) => {
    const { panels, layout, frames } = get();
    const newPanels = [...panels];
    const newLayout = [...layout];

    // Flow panels left-to-right across the 12-col grid, wrapping to new rows.
    let x = 0;
    let rowY = newLayout.reduce((m, it) => Math.max(m, it.y + it.h), 0);
    let rowH = 0;

    for (const { frameId, signalName, unit } of entries) {
      const frame = frames.get(frameId);
      const def = frame && allFrameSignals(frame).find((s) => s.name === signalName);
      const meta = { unit: unit ?? def?.unit, min: def?.min, max: def?.max, enum: def?.enum, format: def?.format };
      const widget = widgetForSignal(meta, def?.display);

      const size = WIDGET_META[widget.type]?.defaultSize ?? { w: 3, h: 3 };
      if (x + size.w > 12) { x = 0; rowY += rowH; rowH = 0; }

      const confidence = signalConfidence(frame, signalName);
      const id = generatePanelId();
      newPanels.push({
        id,
        type: widget.type,
        title: signalName,
        signals: [{ frameId, signalName, unit: meta.unit, colour: SERIES_COLOURS[0], confidence }],
        minValue: widget.minValue ?? 0,
        maxValue: widget.maxValue ?? 100,
        ...(widget.widgetConfig ? { widgetConfig: widget.widgetConfig } : {}),
      });
      newLayout.push({ i: id, x, y: rowY, ...size });
      x += size.w;
      rowH = Math.max(rowH, size.h);
    }

    set({ panels: newPanels, layout: newLayout });
    scheduleAutoSave();
  },

  clonePanel: (panelId) => {
    const { panels, layout } = get();
    const source = panels.find((p) => p.id === panelId);
    const sourceLayout = layout.find((l) => l.i === panelId);
    if (!source || !sourceLayout) return;

    const id = generatePanelId();
    const maxY = layout.reduce((max, item) => Math.max(max, item.y + item.h), 0);

    const cloned: DashboardPanel = {
      ...source,
      id,
      title: `${source.title} (copy)`,
      signals: source.signals.map((s) => ({ ...s })),
    };

    const clonedLayout: LayoutItem = {
      i: id,
      x: 0,
      y: maxY,
      w: sourceLayout.w,
      h: sourceLayout.h,
    };

    set({
      panels: [...panels, cloned],
      layout: [...layout, clonedLayout],
    });
    scheduleAutoSave();
  },

  removePanel: (panelId) => {
    const { panels, layout } = get();
    const remaining = panels.filter((p) => p.id !== panelId);
    set({
      panels: remaining,
      layout: layout.filter((l) => l.i !== panelId),
    });
    if (remaining.length === 0) {
      if (autoSaveTimer) clearTimeout(autoSaveTimer);
      storeDelete(AUTO_SAVE_KEY);
    } else {
      scheduleAutoSave();
    }
  },

  removeAllPanels: () => {
    set({ panels: [], layout: [] });
    if (autoSaveTimer) clearTimeout(autoSaveTimer);
    storeDelete(AUTO_SAVE_KEY);
  },

  updatePanel: (panelId, updates) => {
    const { panels } = get();
    set({
      panels: panels.map((p) =>
        p.id === panelId ? { ...p, ...updates } : p
      ),
    });
    scheduleAutoSave();
  },

  addSignalToPanel: (panelId, frameId, signalName, unit) => {
    const { panels, frames } = get();
    const panel = panels.find((p) => p.id === panelId);
    if (!panel) return;

    // Don't add duplicates
    if (panel.signals.some((s) => s.frameId === frameId && s.signalName === signalName)) return;

    // Assign next colour from palette
    const colour = SERIES_COLOURS[panel.signals.length % SERIES_COLOURS.length];

    const confidence = signalConfidence(frames.get(frameId), signalName);

    const newSignal: SignalRef = { frameId, signalName, unit, colour, confidence };

    // Auto-set title to first signal name when panel still has its default title
    const isDefaultTitle = Object.values(WIDGET_META).some((m) => m.defaultConfig.title === panel.title);
    const newTitle = (panel.signals.length === 0 && isDefaultTitle) ? signalName : panel.title;

    set({
      panels: panels.map((p) =>
        p.id === panelId ? { ...p, title: newTitle, signals: [...p.signals, newSignal] } : p
      ),
    });
    scheduleAutoSave();
  },

  removeSignalFromPanel: (panelId, frameId, signalName) => {
    const { panels } = get();
    set({
      panels: panels.map((p) => {
        if (p.id !== panelId) return p;
        const newSignals = p.signals.filter((s) => !(s.frameId === frameId && s.signalName === signalName));
        // Clamp primarySignalIndex if it now exceeds the signal count
        const clampedIndex = p.primarySignalIndex !== undefined && p.primarySignalIndex >= newSignals.length
          ? Math.max(0, newSignals.length - 1)
          : p.primarySignalIndex;
        return { ...p, signals: newSignals, primarySignalIndex: clampedIndex };
      }),
    });
    scheduleAutoSave();
  },

  updateSignalColour: (panelId, frameId, signalName, colour) => {
    const { panels } = get();
    set({
      panels: panels.map((p) =>
        p.id === panelId
          ? {
              ...p,
              signals: p.signals.map((s) =>
                s.frameId === frameId && s.signalName === signalName
                  ? { ...s, colour }
                  : s
              ),
            }
          : p
      ),
    });
    scheduleAutoSave();
  },

  updateSignalDisplayName: (panelId, frameId, signalName, displayName) => {
    const { panels } = get();
    set({
      panels: panels.map((p) =>
        p.id === panelId
          ? {
              ...p,
              signals: p.signals.map((s) =>
                s.frameId === frameId && s.signalName === signalName
                  ? { ...s, displayName: displayName || undefined }
                  : s
              ),
            }
          : p
      ),
    });
    scheduleAutoSave();
  },

  updateSignalYAxis: (panelId, frameId, signalName, yAxis) => {
    const { panels } = get();
    set({
      panels: panels.map((p) =>
        p.id === panelId
          ? {
              ...p,
              signals: p.signals.map((s) =>
                s.frameId === frameId && s.signalName === signalName
                  ? { ...s, yAxis }
                  : s
              ),
            }
          : p
      ),
    });
    scheduleAutoSave();
  },

  reorderSignals: (panelId, fromIndex, toIndex) => {
    const { panels } = get();
    set({
      panels: panels.map((p) => {
        if (p.id !== panelId) return p;
        const signals = [...p.signals];
        const [moved] = signals.splice(fromIndex, 1);
        signals.splice(toIndex, 0, moved);
        // Adjust primarySignalIndex if affected by the reorder
        let primary = p.primarySignalIndex;
        if (primary !== undefined) {
          if (primary === fromIndex) {
            primary = toIndex;
          } else if (fromIndex < primary && toIndex >= primary) {
            primary--;
          } else if (fromIndex > primary && toIndex <= primary) {
            primary++;
          }
        }
        return { ...p, signals, primarySignalIndex: primary };
      }),
    });
    scheduleAutoSave();
  },

  replaceSignalSource: (panelId, oldFrameId, oldSignalName, newFrameId, newSignalName, newUnit) => {
    const { panels, frames } = get();

    const confidence = signalConfidence(frames.get(newFrameId), newSignalName);

    set({
      panels: panels.map((p) => {
        if (p.id !== panelId) return p;
        // Don't replace if target already exists in this panel
        if (p.signals.some((s) => s.frameId === newFrameId && s.signalName === newSignalName)) return p;
        return {
          ...p,
          signals: p.signals.map((s) =>
            s.frameId === oldFrameId && s.signalName === oldSignalName
              ? { ...s, frameId: newFrameId, signalName: newSignalName, unit: newUnit, confidence }
              : s
          ),
        };
      }),
    });
    scheduleAutoSave();
  },

  updateLayout: (layout) => {
    set({ layout });
    scheduleAutoSave();
  },

  setFollowMode: (panelId, follow) => {
    const { panels } = get();
    set({
      panels: panels.map((p) =>
        p.id === panelId ? { ...p, followMode: follow } : p
      ),
    });
    scheduleAutoSave();
  },

  toggleStats: (panelId) => {
    const { panels } = get();
    set({
      panels: panels.map((p) =>
        p.id === panelId ? { ...p, showStats: !p.showStats } : p
      ),
    });
    scheduleAutoSave();
  },

  triggerZoomReset: () => {
    set((state) => ({ zoomResetVersion: state.zoomResetVersion + 1 }));
  },

  // ── Layout persistence ──

  loadSavedLayouts: async () => {
    const layouts = await getAllDashboardLayouts();
    set({ savedLayouts: layouts });
  },

  saveCurrentLayout: async (name) => {
    const { catalogPath, panels, layout, candidateRegistry } = get();
    const filename = catalogFilenameFromPath(catalogPath);
    await saveDashboardLayout(name, filename, panels, layout, candidateRegistry);
    const layouts = await getAllDashboardLayouts();
    set({ savedLayouts: layouts });
  },

  loadLayout: (savedLayout) => {
    set({
      panels: structuredClone(savedLayout.panels),
      layout: structuredClone(savedLayout.layout),
      latest: new Map(),
      dataVersion: 0,
      discoveredFrameIds: new Set(),
      bitChangeCounts: new Map(),
      candidateRegistry: savedLayout.candidateRegistry
        ? new Map(savedLayout.candidateRegistry)
        : new Map(),
    });
    scheduleAutoSave();
  },

  loadDashboard: (dashboard) => {
    const now = Date.now();
    get().loadLayout({
      id: 'dashboard',
      name: dashboard.name || 'Dashboard',
      catalogFilename: dashboard.catalogFilename || '',
      panels: dashboard.panels,
      layout: dashboard.layout,
      candidateRegistry: dashboard.candidateRegistry,
      createdAt: dashboard.createdAt ?? now,
      updatedAt: dashboard.updatedAt ?? now,
    });
  },

  deleteSavedLayout: async (id) => {
    await deleteDashboardLayout(id);
    const layouts = await getAllDashboardLayouts();
    set({ savedLayouts: layouts });
  },

  restoreLastSession: async () => {
    const saved = await storeGet<{
      panels: DashboardPanel[];
      layout: LayoutItem[];
      candidateRegistry?: [string, HypothesisParams][];
    }>(AUTO_SAVE_KEY);
    if (saved && saved.panels.length > 0) {
      set({
        panels: saved.panels,
        layout: saved.layout,
        candidateRegistry: saved.candidateRegistry
          ? new Map(saved.candidateRegistry)
          : new Map(),
      });
    }
  },

  // ── Data ingestion ──

  setLatest: (values) => {
    if (values.size === 0) return;
    const latest = new Map(get().latest);
    for (const [key, value] of values) latest.set(key, value);
    set((state) => ({ latest, dataVersion: state.dataVersion + 1 }));
  },

  clearData: () => {
    set({
      latest: new Map(),
      dataVersion: 0,
      discoveredFrameIds: new Set(),
      bitChangeCounts: new Map(),
    });
  },

  recordFrameId: (frameId) => {
    const ids = get().discoveredFrameIds;
    if (!ids.has(frameId)) {
      const next = new Set(ids);
      next.add(frameId);
      set({ discoveredFrameIds: next });
    }
  },

  setBitToggles: (toggles) => {
    if (toggles.length === 0) return;
    const next = new Map(get().bitChangeCounts);
    for (const { frameId, counts, frames } of toggles) next.set(frameId, { counts, totalFrames: frames });
    set({ bitChangeCounts: next });
  },

  registerHypotheses: (entries) => {
    const { candidateRegistry } = get();
    const next = new Map(candidateRegistry);
    for (const { signalName, params } of entries) {
      next.set(signalName, params);
    }
    set({ candidateRegistry: next });
    scheduleAutoSave();
  },

  clearHypothesisRegistry: () => {
    set({ candidateRegistry: new Map() });
    scheduleAutoSave();
  },
}));
