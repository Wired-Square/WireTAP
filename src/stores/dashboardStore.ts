// ui/src/stores/dashboardStore.ts

import { create } from 'zustand';
import { tlog } from '../api/settings';
import type { FrameDetail, SignalDef, MuxDef } from '../types/decoder';
import type { Confidence } from '../types/catalog';
import type { CanProtocolConfig, ParsedCatalog } from '../utils/catalogParser';
import { loadCatalog as loadCatalogFromPath, attachAndResolve } from '../utils/catalogParser';

import type { SerialFrameConfig } from '../utils/frameExport';
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
import { parseDisplayHints, type DisplayHint } from '../apps/dashboard/widgets/displayHints';
import type { DashboardFileContent } from '../utils/dashboards';

// ─────────────────────────────────────────
// Types
// ─────────────────────────────────────────

/** Type of visualisation panel */
export type PanelType =
  | 'line-chart' | 'gauge' | 'list' | 'flow' | 'heatmap' | 'histogram'
  | 'icon-state' | 'rotary' | 'level-bar' | 'bitfield' | 'raw-canvas' | 'custom-svg';

/** Colour palette for signal lines */
const SIGNAL_COLOURS = [
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

/** Circular buffer for time-series data for one signal */
export interface SignalTimeSeries {
  timestamps: Float64Array;
  values: Float64Array;
  writeIndex: number;
  count: number;
  latestValue: number;
  latestTimestamp: number;
  /** Running statistics (reset on clearData) */
  min: number;
  max: number;
  sum: number;
  sampleCount: number;
}

/** Default time-series buffer capacity (configurable via settings) */
let timeseriesCapacity = 10_000;

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

/** Signal value entry for batch push */
export interface SignalValueEntry {
  frameId: number;
  signalName: string;
  value: number;
  timestamp: number;
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

function createTimeSeries(): SignalTimeSeries {
  return {
    timestamps: new Float64Array(timeseriesCapacity),
    values: new Float64Array(timeseriesCapacity),
    writeIndex: 0,
    count: 0,
    latestValue: 0,
    latestTimestamp: 0,
    min: Infinity,
    max: -Infinity,
    sum: 0,
    sampleCount: 0,
  };
}

function makeSignalKey(frameId: number, signalName: string): string {
  return `${frameId}:${signalName}`;
}

let panelCounter = 0;
function generatePanelId(): string {
  return `panel_${Date.now()}_${panelCounter++}`;
}

/** Recursively search a frame (incl. mux cases) for a signal's definition. */
function findSignalDef(frame: FrameDetail, name: string): SignalDef | undefined {
  const direct = frame.signals.find((s) => s.name === name);
  if (direct) return direct;
  return frame.mux ? findMuxSignalDef(frame.mux, name) : undefined;
}

function findMuxSignalDef(mux: MuxDef, name: string): SignalDef | undefined {
  for (const caseKey of Object.keys(mux.cases)) {
    const c = mux.cases[caseKey];
    const sig = c.signals.find((s) => s.name === name);
    if (sig) return sig;
    if (c.mux) {
      const nested = findMuxSignalDef(c.mux, name);
      if (nested) return nested;
    }
  }
  return undefined;
}

/** Recursively search mux cases for a signal's confidence */
function findMuxSignalConfidence(mux: MuxDef, signalName: string): Confidence | undefined {
  for (const caseKey of Object.keys(mux.cases)) {
    const muxCase = mux.cases[caseKey];
    const sig = muxCase.signals.find((s) => s.name === signalName);
    if (sig?.confidence) return sig.confidence;
    if (muxCase.mux) {
      const nested = findMuxSignalConfidence(muxCase.mux, signalName);
      if (nested) return nested;
    }
  }
  return undefined;
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
  frames: Map<number, FrameDetail>;
  protocol: 'can' | 'serial' | 'modbus';
  canConfig: CanProtocolConfig | null;
  serialConfig: SerialFrameConfig | null;
  /** Default byte order from catalog */
  defaultByteOrder: 'big' | 'little';
  /** Frame ID mask for catalog lookup */
  frameIdMask: number | undefined;
  /** Per-signal display hints from the catalog, keyed "frameId:signalName". */
  displayHints: Map<string, DisplayHint>;

  // ── IO Session ──
  ioProfile: string | null;
  playbackSpeed: number;

  // ── Panels & Layout ──
  panels: DashboardPanel[];
  layout: LayoutItem[];

  // ── Time-series Data ──
  seriesBuffers: Map<string, SignalTimeSeries>;
  /** Monotonically increasing version counter — panels subscribe to this to know when to re-read buffers */
  dataVersion: number;

  // ── Chart interaction ──
  /** Monotonically increasing counter — line charts reset zoom when this changes */
  zoomResetVersion: number;

  // ── Raw byte tracking (flow view / heatmap) ──
  /** Frame IDs seen during the current session (for flow/heatmap frame pickers) */
  discoveredFrameIds: Set<number>;
  /** Bit change counters for heatmap panels: key = frameId */
  bitChangeCounts: Map<number, { counts: Uint32Array; lastBytes: Uint8Array; totalFrames: number }>;

  /** Registry of hypothesis signal parameters, keyed by hyp_* signal name */
  candidateRegistry: Map<string, HypothesisParams>;

  // ── Actions ──
  /** Parse-only load (no session bind). */
  loadCatalog: (path: string) => Promise<void>;
  /** Attach to a session for Rust decode AND load the model from that one parse. */
  loadCatalogForSession: (sessionId: string, path: string) => Promise<void>;
  /** Build the in-memory model from an already-resolved catalogue. */
  applyParsedCatalog: (catalog: ParsedCatalog) => void;
  /** Track the active catalogue path without parsing. */
  setCatalogPath: (path: string | null) => void;
  initFromSettings: (decoderDir?: string, defaultReadProfile?: string | null) => Promise<void>;
  setIoProfile: (profile: string | null) => void;
  setPlaybackSpeed: (speed: number) => void;
  setBufferCapacity: (capacity: number) => void;

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
  pushSignalValues: (entries: SignalValueEntry[]) => void;
  clearData: () => void;

  // Raw byte tracking (flow view / heatmap)
  recordFrameId: (frameId: number) => void;
  recordBitChanges: (frameId: number, bytes: number[]) => void;

  // Hypothesis candidate registry
  registerHypotheses: (entries: Array<{ signalName: string; params: HypothesisParams }>) => void;
  clearHypothesisRegistry: () => void;
}

export const useDashboardStore = create<DashboardState>((set, get) => ({
  // ── Initial state ──
  catalogPath: null,
  frames: new Map(),
  protocol: 'can',
  canConfig: null,
  serialConfig: null,
  defaultByteOrder: 'little',
  frameIdMask: undefined,
  displayHints: new Map(),

  ioProfile: null,
  playbackSpeed: 1,

  panels: [],
  layout: [],
  savedLayouts: [],

  seriesBuffers: new Map(),
  dataVersion: 0,
  zoomResetVersion: 0,
  discoveredFrameIds: new Set(),
  bitChangeCounts: new Map(),
  candidateRegistry: new Map(),

  // ── Actions ──

  loadCatalog: async (path: string) => {
    get().applyParsedCatalog(await loadCatalogFromPath(path));
  },

  loadCatalogForSession: async (sessionId: string, path: string) => {
    try {
      get().applyParsedCatalog(await attachAndResolve(sessionId, path));
    } catch (e) {
      tlog.info(`[dashboardStore] catalog attach failed, loading model only: ${e}`);
      await get().loadCatalog(path);
    }
  },

  setCatalogPath: (path: string | null) => set({ catalogPath: path }),

  // Apply a parsed catalogue to the dashboard's decode model. The catalogue PATH is
  // owned by the session (Rust-authoritative, mirrored one-way via useSessionCatalog) —
  // this must NOT write `catalogPath`, or it races the mirror into a reload loop.
  applyParsedCatalog: (catalog: ParsedCatalog) => {
    try {
      // Convert ParsedCatalog frames to FrameDetail format
      const frameMap = new Map<number, FrameDetail>();
      for (const [id, frame] of catalog.frames) {
        frameMap.set(id, {
          id,
          len: frame.length,
          isExtended: frame.isExtended,
          bus: frame.bus,
          lenMismatch: false,
          signals: frame.signals as SignalDef[],
          mux: frame.mux,
          interval: frame.interval,
        });
      }

      // Determine default byte order
      const defaultByteOrder: 'big' | 'little' =
        catalog.canConfig?.default_byte_order ??
        catalog.serialConfig?.default_byte_order ??
        'little';

      // Determine frame ID mask
      const frameIdMask = catalog.protocol === 'can'
        ? catalog.canConfig?.frame_id_mask
        : catalog.serialConfig?.frame_id_mask;

      // Convert SerialProtocolConfig to SerialFrameConfig
      let serialConfig: SerialFrameConfig | null = null;
      if (catalog.serialConfig) {
        const sc = catalog.serialConfig;
        serialConfig = {
          default_byte_order: sc.default_byte_order,
          encoding: sc.encoding,
          frame_id_start_byte: sc.frame_id_start_byte,
          frame_id_bytes: sc.frame_id_bytes,
          frame_id_byte_order: sc.frame_id_byte_order,
          frame_id_mask: sc.frame_id_mask,
          source_address_start_byte: sc.source_address_start_byte,
          source_address_bytes: sc.source_address_bytes,
          source_address_byte_order: sc.source_address_byte_order,
          min_frame_length: sc.min_frame_length,
          header_length: sc.header_length,
        };
      }

      set({
        frames: frameMap,
        protocol: catalog.protocol,
        canConfig: catalog.canConfig,
        serialConfig,
        defaultByteOrder,
        frameIdMask,
        displayHints: parseDisplayHints(catalog.rawToml),
      });
    } catch (e) {
      tlog.info(`[dashboardStore] Failed to load catalog: ${e}`);
      throw e;
    }
  },

  initFromSettings: async (_decoderDir, defaultReadProfile) => {
    if (defaultReadProfile) {
      set({ ioProfile: defaultReadProfile });
    }
    // Restore panels from last session
    await get().restoreLastSession();
  },

  setIoProfile: (profile) => set({ ioProfile: profile }),
  setPlaybackSpeed: (speed) => set({ playbackSpeed: speed }),
  setBufferCapacity: (capacity) => {
    const clamped = Math.max(1_000, Math.min(100_000, capacity));
    timeseriesCapacity = clamped;
  },

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
    const { panels, layout, frames, displayHints } = get();
    const newPanels = [...panels];
    const newLayout = [...layout];

    // Flow panels left-to-right across the 12-col grid, wrapping to new rows.
    let x = 0;
    let rowY = newLayout.reduce((m, it) => Math.max(m, it.y + it.h), 0);
    let rowH = 0;

    for (const { frameId, signalName, unit } of entries) {
      const frame = frames.get(frameId);
      const def = frame ? findSignalDef(frame, signalName) : undefined;
      const meta = { unit: unit ?? def?.unit, min: def?.min, max: def?.max, enum: def?.enum, format: def?.format };
      const hint = displayHints.get(makeSignalKey(frameId, signalName));
      const widget = widgetForSignal(meta, hint);

      const size = WIDGET_META[widget.type]?.defaultSize ?? { w: 3, h: 3 };
      if (x + size.w > 12) { x = 0; rowY += rowH; rowH = 0; }

      const confidence = def?.confidence ?? (frame?.mux ? findMuxSignalConfidence(frame.mux, signalName) : undefined);
      const id = generatePanelId();
      newPanels.push({
        id,
        type: widget.type,
        title: signalName,
        signals: [{ frameId, signalName, unit: meta.unit, colour: SIGNAL_COLOURS[0], confidence }],
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
    const colourIndex = panel.signals.length % SIGNAL_COLOURS.length;
    const colour = SIGNAL_COLOURS[colourIndex];

    // Look up confidence from catalog
    let confidence: Confidence | undefined;
    const frame = frames.get(frameId);
    if (frame) {
      const signalDef = frame.signals.find((s) => s.name === signalName);
      if (signalDef?.confidence) {
        confidence = signalDef.confidence;
      } else if (frame.mux) {
        confidence = findMuxSignalConfidence(frame.mux, signalName);
      }
    }

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

    // Look up confidence for the new signal
    let confidence: Confidence | undefined;
    const frame = frames.get(newFrameId);
    if (frame) {
      const signalDef = frame.signals.find((s) => s.name === newSignalName);
      if (signalDef?.confidence) {
        confidence = signalDef.confidence;
      } else if (frame.mux) {
        confidence = findMuxSignalConfidence(frame.mux, newSignalName);
      }
    }

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
      seriesBuffers: new Map(),
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

  pushSignalValues: (entries) => {
    const { seriesBuffers } = get();
    // Mutate in place for performance — ring buffers are never replaced, only written to
    const newBuffers = new Map(seriesBuffers);
    let created = false;

    for (const { frameId, signalName, value, timestamp } of entries) {
      const key = makeSignalKey(frameId, signalName);
      let series = newBuffers.get(key);
      if (!series) {
        series = createTimeSeries();
        newBuffers.set(key, series);
        created = true;
      }

      const cap = series.timestamps.length;
      series.timestamps[series.writeIndex] = timestamp;
      series.values[series.writeIndex] = value;
      series.writeIndex = (series.writeIndex + 1) % cap;
      if (series.count < cap) series.count++;
      series.latestValue = value;
      series.latestTimestamp = timestamp;

      // Running statistics
      if (value < series.min) series.min = value;
      if (value > series.max) series.max = value;
      series.sum += value;
      series.sampleCount++;
    }

    // Only replace the map reference if we created new entries, otherwise
    // just bump the version to trigger re-renders via the dataVersion selector
    if (created) {
      set((state) => ({ seriesBuffers: newBuffers, dataVersion: state.dataVersion + 1 }));
    } else {
      set((state) => ({ dataVersion: state.dataVersion + 1 }));
    }
  },

  clearData: () => {
    set({
      seriesBuffers: new Map(),
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

  recordBitChanges: (frameId, bytes) => {
    const map = get().bitChangeCounts;
    let entry = map.get(frameId);
    if (!entry) {
      entry = {
        counts: new Uint32Array(64),
        lastBytes: new Uint8Array(8),
        totalFrames: 0,
      };
      // Initialise lastBytes with current frame to avoid spurious first-frame changes
      for (let i = 0; i < Math.min(bytes.length, 8); i++) {
        entry.lastBytes[i] = bytes[i];
      }
      const next = new Map(map);
      next.set(frameId, entry);
      set({ bitChangeCounts: next });
      entry.totalFrames++;
      return;
    }
    // XOR to find changed bits
    const len = Math.min(bytes.length, 8);
    for (let byteIdx = 0; byteIdx < len; byteIdx++) {
      const diff = entry.lastBytes[byteIdx] ^ bytes[byteIdx];
      if (diff !== 0) {
        for (let bit = 0; bit < 8; bit++) {
          if (diff & (1 << bit)) {
            entry.counts[byteIdx * 8 + bit]++;
          }
        }
      }
      entry.lastBytes[byteIdx] = bytes[byteIdx];
    }
    entry.totalFrames++;
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

// ─────────────────────────────────────────
// Ring buffer read helpers (used by chart components)
// ─────────────────────────────────────────

/**
 * Extract chronologically ordered data from a ring buffer.
 * Returns [timestamps, values] arrays of length series.count.
 */
export function readTimeSeries(series: SignalTimeSeries): { timestamps: number[]; values: number[] } {
  const { count, writeIndex, timestamps, values } = series;
  const cap = timestamps.length;
  const startIdx = count < cap ? 0 : writeIndex;

  const ts = new Array<number>(count);
  const vs = new Array<number>(count);
  for (let i = 0; i < count; i++) {
    const idx = (startIdx + i) % cap;
    ts[i] = timestamps[idx];
    vs[i] = values[idx];
  }
  return { timestamps: ts, values: vs };
}

/**
 * Build uPlot-compatible AlignedData from multiple signal ring buffers.
 * Returns [timestamps, ...seriesValues] where each is a number[].
 * Signals may have different update rates; we use the first signal's timestamps
 * as the shared x-axis and interpolate others to match.
 */
export function buildAlignedData(
  signals: SignalRef[],
  buffers: Map<string, SignalTimeSeries>,
): (number[] | null[])[] {
  if (signals.length === 0) return [[]];

  // Use first signal with data as the time base
  let baseKey: string | null = null;
  let baseSeries: SignalTimeSeries | null = null;
  for (const sig of signals) {
    const key = makeSignalKey(sig.frameId, sig.signalName);
    const s = buffers.get(key);
    if (s && s.count > 0) {
      baseKey = key;
      baseSeries = s;
      break;
    }
  }

  if (!baseSeries || !baseKey) return [[]];

  const base = readTimeSeries(baseSeries);
  const data: (number[] | null[])[] = [base.timestamps];

  for (const sig of signals) {
    const key = makeSignalKey(sig.frameId, sig.signalName);
    if (key === baseKey) {
      data.push(base.values);
    } else {
      const s = buffers.get(key);
      if (s && s.count > 0) {
        const read = readTimeSeries(s);
        data.push(read.values);
      } else {
        // No data yet for this signal
        data.push(new Array(base.timestamps.length).fill(null));
      }
    }
  }

  return data;
}
