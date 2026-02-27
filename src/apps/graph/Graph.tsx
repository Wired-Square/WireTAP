// ui/src/apps/graph/Graph.tsx

import { useEffect, useState, useCallback, useRef } from "react";
import { useSettings } from "../../hooks/useSettings";
import { useGraphStore, type SignalValueEntry } from "../../stores/graphStore";
import { useIOSessionManager } from "../../hooks/useIOSessionManager";
import { useMenuSessionControl } from "../../hooks/useMenuSessionControl";
import { useIOPickerHandlers } from "../../hooks/useIOPickerHandlers";
import { useSessionStore } from "../../stores/sessionStore";
import { useSettingsStore } from "../settings/stores/settingsStore";
import { listCatalogs, type CatalogMetadata } from "../../api/catalog";
import { mergeSerialConfig } from "../../utils/sessionConfigMerge";
import { buildCatalogPath } from "../../utils/catalogUtils";
import { tlog } from "../../api/settings";
import { UI_UPDATE_INTERVAL_MS } from "../../constants";
import { catalogFilenameFromPath } from "../../utils/graphLayouts";
import { onStoreChanged } from "../../api/store";
import AppLayout from "../../components/AppLayout";
import GraphTopBar from "./views/GraphTopBar";
import GraphGrid from "./views/GraphGrid";
import CodeView from "../../components/CodeView";
import CatalogPickerDialog from "../../dialogs/CatalogPickerDialog";
import IoReaderPickerDialog from "../../dialogs/IoReaderPickerDialog";
import SignalPickerDialog from "./dialogs/SignalPickerDialog";
import PanelConfigDialog from "./dialogs/PanelConfigDialog";
import CandidateSignalsDialog from "./dialogs/CandidateSignalsDialog";
import HypothesisExplorerDialog from "./dialogs/HypothesisExplorerDialog";
import DecoderConflictDialog, { type DecoderConflictOption } from "../../dialogs/DecoderConflictDialog";
import { useDialogManager } from "../../hooks/useDialogManager";
import { decodeSignal } from "../../utils/signalDecode";
import { extractBits } from "../../utils/bits";
import { findMatchingMuxCase } from "../../utils/muxCaseMatch";
import type { FrameMessage } from "../../types/frame";
import type { MuxDef } from "../../types/decoder";

export default function Graph() {
  const { settings } = useSettings();
  const [catalogs, setCatalogs] = useState<CatalogMetadata[]>([]);

  // Dialog to configure which panel
  const [configuringPanelId, setConfiguringPanelId] = useState<string | null>(null);

  // Replace signal mode
  const [replacingSignalIndex, setReplacingSignalIndex] = useState<number | null>(null);

  // Raw view mode
  const [rawViewMode, setRawViewMode] = useState(false);
  const [rawViewContent, setRawViewContent] = useState("");

  const dialogs = useDialogManager([
    'ioReaderPicker',
    'catalogPicker',
    'signalPicker',
    'panelConfig',
    'candidateSignals',
    'hypothesisExplorer',
    'decoderConflict',
  ] as const);
  const [decoderConflictOptions, setDecoderConflictOptions] = useState<DecoderConflictOption[]>([]);

  // Store selectors
  const catalogPath = useGraphStore((s) => s.catalogPath);
  const frames = useGraphStore((s) => s.frames);
  const ioProfile = useGraphStore((s) => s.ioProfile);
  const defaultByteOrder = useGraphStore((s) => s.defaultByteOrder);
  const frameIdMask = useGraphStore((s) => s.frameIdMask);

  // Store actions
  const initFromSettings = useGraphStore((s) => s.initFromSettings);
  const setIoProfile = useGraphStore((s) => s.setIoProfile);
  const loadCatalog = useGraphStore((s) => s.loadCatalog);
  const pushSignalValues = useGraphStore((s) => s.pushSignalValues);
  const clearData = useGraphStore((s) => s.clearData);
  const setPlaybackSpeed = useGraphStore((s) => s.setPlaybackSpeed);
  const setBufferCapacity = useGraphStore((s) => s.setBufferCapacity);

  // Layout persistence
  const savedLayouts = useGraphStore((s) => s.savedLayouts);
  const saveCurrentLayout = useGraphStore((s) => s.saveCurrentLayout);
  const loadLayout = useGraphStore((s) => s.loadLayout);
  const deleteSavedLayout = useGraphStore((s) => s.deleteSavedLayout);
  const loadSavedLayouts = useGraphStore((s) => s.loadSavedLayouts);

  const decoderDir = settings?.decoder_dir ?? "";

  // ── Raw view toggle ──
  const handleToggleRawView = useCallback(() => {
    if (!rawViewMode) {
      // Entering raw view: merge panels + layout into a single flat array per panel
      const { panels, layout } = useGraphStore.getState();
      const layoutMap = new Map(layout.map((l) => [l.i, l]));
      const merged = panels.map((p) => {
        const li = layoutMap.get(p.id);
        return {
          ...p,
          x: li?.x ?? 0,
          y: li?.y ?? 0,
          w: li?.w ?? 6,
          h: li?.h ?? 3,
        };
      });
      setRawViewContent(JSON.stringify({ panels: merged }, null, 2));
    } else {
      // Leaving raw view: split flat panels back into panels + layout
      try {
        const parsed = JSON.parse(rawViewContent);
        if (Array.isArray(parsed.panels)) {
          const panels = parsed.panels.map(({ x, y, w, h, ...rest }: Record<string, unknown>) => rest);
          const layout = parsed.panels.map((p: Record<string, unknown>) => ({
            i: p.id as string,
            x: (p.x as number) ?? 0,
            y: (p.y as number) ?? 0,
            w: (p.w as number) ?? 6,
            h: (p.h as number) ?? 3,
          }));
          loadLayout({
            id: 'import',
            name: 'Imported',
            catalogFilename: catalogFilenameFromPath(catalogPath),
            panels,
            layout,
            createdAt: Date.now(),
            updatedAt: Date.now(),
          });
        }
      } catch {
        // Invalid JSON — discard and exit raw view
      }
    }
    setRawViewMode(!rawViewMode);
  }, [rawViewMode, rawViewContent, catalogPath, loadLayout]);

  // ── Frame batching ──
  const pendingValuesRef = useRef<SignalValueEntry[]>([]);
  const flushScheduledRef = useRef(false);
  const pushSignalValuesRef = useRef(pushSignalValues);
  // UI_UPDATE_INTERVAL_MS imported from constants

  useEffect(() => {
    pushSignalValuesRef.current = pushSignalValues;
  }, [pushSignalValues]);

  const flushPendingValues = useCallback(() => {
    flushScheduledRef.current = false;
    const values = pendingValuesRef.current;
    if (values.length === 0) return;
    pendingValuesRef.current = [];
    pushSignalValuesRef.current(values);
  }, []);

  // Refs for frame handling to avoid stale closures
  const framesRef = useRef(frames);
  const defaultByteOrderRef = useRef(defaultByteOrder);
  const frameIdMaskRef = useRef(frameIdMask);

  useEffect(() => { framesRef.current = frames; }, [frames]);
  useEffect(() => { defaultByteOrderRef.current = defaultByteOrder; }, [defaultByteOrder]);
  useEffect(() => { frameIdMaskRef.current = frameIdMask; }, [frameIdMask]);

  const handleFrames = useCallback((receivedFrames: FrameMessage[]) => {
    if (!receivedFrames || receivedFrames.length === 0) return;

    const catalogFrames = framesRef.current;
    const byteOrder = defaultByteOrderRef.current;
    const mask = frameIdMaskRef.current;
    const store = useGraphStore.getState();

    for (const f of receivedFrames) {
      const timestamp = f.timestamp_us !== undefined ? f.timestamp_us / 1_000_000 : Date.now() / 1000;
      const maskedFrameId = mask !== undefined ? (f.frame_id & mask) : f.frame_id;

      // Record all seen frame IDs (for flow/heatmap frame pickers)
      store.recordFrameId(maskedFrameId);

      // Raw byte ingestion for flow/heatmap panels
      for (const panel of store.panels) {
        if ((panel.type === 'flow' || panel.type === 'heatmap') && panel.targetFrameId === maskedFrameId) {
          if (panel.type === 'flow') {
            const count = panel.byteCount ?? 8;
            for (let i = 0; i < Math.min(count, f.bytes.length); i++) {
              pendingValuesRef.current.push({
                frameId: maskedFrameId,
                signalName: `byte[${i}]`,
                value: f.bytes[i],
                timestamp,
              });
            }
          }
          if (panel.type === 'heatmap') {
            store.recordBitChanges(maskedFrameId, f.bytes);
          }
        }
      }

      // Candidate signal decode (byte_<offset>_<bits>b_<endian> pattern)
      for (const panel of store.panels) {
        if (panel.type !== 'line-chart') continue;
        for (const sig of panel.signals) {
          if (sig.frameId !== maskedFrameId) continue;
          const m = /^byte_(\d+)_(\d+)b_(le|be)$/.exec(sig.signalName);
          if (!m) continue;
          const offset = parseInt(m[1], 10);
          const bits = parseInt(m[2], 10);
          const byteLen = bits / 8;
          if (offset + byteLen > f.bytes.length) continue;
          let value: number;
          if (bits === 8) {
            value = f.bytes[offset];
          } else if (bits === 16) {
            value = m[3] === "le"
              ? f.bytes[offset] | (f.bytes[offset + 1] << 8)
              : (f.bytes[offset] << 8) | f.bytes[offset + 1];
          } else {
            // 32-bit
            value = m[3] === "le"
              ? f.bytes[offset] | (f.bytes[offset + 1] << 8) | (f.bytes[offset + 2] << 16) | ((f.bytes[offset + 3] << 24) >>> 0)
              : ((f.bytes[offset] << 24) >>> 0) | (f.bytes[offset + 1] << 16) | (f.bytes[offset + 2] << 8) | f.bytes[offset + 3];
            value = value >>> 0; // unsigned
          }
          pendingValuesRef.current.push({
            frameId: maskedFrameId,
            signalName: sig.signalName,
            value,
            timestamp,
          });
        }
      }

      // Hypothesis signal decode (hyp_* prefix — uses candidateRegistry)
      if (store.candidateRegistry.size > 0) {
        for (const panel of store.panels) {
          if (panel.type !== 'line-chart' && panel.type !== 'histogram') continue;
          for (const sig of panel.signals) {
            if (sig.frameId !== maskedFrameId) continue;
            if (!sig.signalName.startsWith('hyp_')) continue;
            const params = store.candidateRegistry.get(sig.signalName);
            if (!params) continue;
            if (params.startBit + params.bitLength > f.bytes.length * 8) continue;
            const raw = extractBits(f.bytes, params.startBit, params.bitLength, params.endianness, params.signed);
            const value = raw * params.factor + params.offset;
            if (isFinite(value)) {
              pendingValuesRef.current.push({
                frameId: maskedFrameId,
                signalName: sig.signalName,
                value,
                timestamp,
              });
            }
          }
        }
      }

      // Catalog-based decode
      const frame = catalogFrames.get(maskedFrameId);
      if (!frame) continue;

      // Decode all signals in this frame
      for (const signal of frame.signals) {
        if (!signal.name) continue;
        const decoded = decodeSignal(f.bytes, signal, signal.name, byteOrder);
        // Only graph numeric values (skip hex, ascii, enum-only)
        if (typeof decoded.scaled === 'number' && isFinite(decoded.scaled)) {
          pendingValuesRef.current.push({
            frameId: maskedFrameId,
            signalName: decoded.name,
            value: decoded.scaled,
            timestamp,
          });
        }
      }

      // Decode mux signals if present
      if (frame.mux) {
        decodeMuxForGraph(f.bytes, frame.mux, maskedFrameId, byteOrder, timestamp);
      }
    }

    if (!flushScheduledRef.current && pendingValuesRef.current.length > 0) {
      flushScheduledRef.current = true;
      setTimeout(flushPendingValues, UI_UPDATE_INTERVAL_MS);
    }
  }, [flushPendingValues]);

  // Helper for recursive mux decoding
  const decodeMuxForGraph = useCallback((
    bytes: number[],
    mux: MuxDef,
    frameId: number,
    byteOrder: 'big' | 'little',
    timestamp: number,
  ) => {
    const selectorValue = extractBits(bytes, mux.start_bit, mux.bit_length, byteOrder, false);
    const matchingKey = findMatchingMuxCase(selectorValue, Object.keys(mux.cases));
    if (!matchingKey) return;

    const activeCase = mux.cases[matchingKey];
    for (const signal of activeCase.signals) {
      if (!signal.name) continue;
      const decoded = decodeSignal(bytes, signal, signal.name, byteOrder);
      if (typeof decoded.scaled === 'number' && isFinite(decoded.scaled)) {
        pendingValuesRef.current.push({
          frameId,
          signalName: decoded.name,
          value: decoded.scaled,
          timestamp,
        });
      }
    }

    if (activeCase.mux) {
      decodeMuxForGraph(bytes, activeCase.mux, frameId, byteOrder, timestamp);
    }
  }, []);

  const handleError = useCallback((error: string) => {
    console.error("Graph stream error:", error);
  }, []);

  // ── Session manager ──
  const manager = useIOSessionManager({
    appName: "graph",
    ioProfiles: settings?.io_profiles ?? [],
    store: { ioProfile, setIoProfile },
    requireFrames: true,
    onFrames: handleFrames,
    onError: handleError,
    setPlaybackSpeed: setPlaybackSpeed as (speed: number) => void,
    onBeforeWatch: clearData,
    onBeforeMultiWatch: clearData,
  });

  const {
    // Session
    session,
    // Profile
    ioProfileName,
    sourceProfileId,
    // Multi-bus state
    multiBusProfiles,
    // Derived state
    isStreaming,
    isPaused,
    isStopped,
    sessionReady,
    capabilities,
    isDetached,
    joinerCount,
    handleLeave,
    resumeWithNewBuffer,
    // Watch state
    isWatching,
    watchFrameCount,
    stopWatch,
  } = manager;

  const { sessionId, state: readerState } = session;

  // Subscribe to session's catalogPath. Returns undefined when session doesn't exist
  // in the store yet, null when it exists with no decoder, or a string path.
  const sessionCatalogPath = useSessionStore((s) => {
    if (!sessionId) return undefined;
    const sess = s.sessions[sessionId];
    if (!sess) return undefined;
    return sess.catalogPath;
  });

  // Cross-app decoder sync: when another app (or Session Manager) changes the
  // session's catalogPath to a non-null value, load it locally.
  useEffect(() => {
    if (!sessionCatalogPath || sessionCatalogPath === catalogPath) return;
    tlog.debug(`[Graph] session decoder changed externally → ${sessionCatalogPath}`);
    loadCatalog(sessionCatalogPath).catch(console.error);
  }, [sessionCatalogPath, catalogPath, loadCatalog]);

  // Auto-set session decoder from source profiles' preferred_catalog when a new session
  // starts. Fires when sessionCatalogPath transitions from undefined to null.
  useEffect(() => {
    if (sessionCatalogPath !== null) return;
    if (!sessionId) return;

    const profiles = useSettingsStore.getState().ioProfiles.profiles;
    const profileIds = multiBusProfiles.length > 0
      ? multiBusProfiles : sourceProfileId ? [sourceProfileId] : [];
    const preferredCatalogs = [...new Set(
      profileIds.map(id => profiles.find(p => p.id === id)?.preferred_catalog).filter(Boolean)
    )] as string[];

    tlog.debug(`[Graph] auto-load check: profileIds=${JSON.stringify(profileIds)}, preferred=${JSON.stringify(preferredCatalogs)}, localCatalog=${catalogPath}`);

    if (preferredCatalogs.length === 1) {
      const path = buildCatalogPath(preferredCatalogs[0], decoderDir);
      tlog.debug(`[Graph] auto-loading preferred decoder → ${path}`);
      loadCatalog(path).catch((err) => {
        console.warn("[Graph] Failed to auto-load preferred decoder:", err);
      });
      useSessionStore.getState().setSessionCatalogPath(sessionId, path);
    } else if (preferredCatalogs.length > 1) {
      tlog.debug(`[Graph] multiple preferred decoders: ${preferredCatalogs.join(", ")}`);
      const options: DecoderConflictOption[] = preferredCatalogs.map(filename => ({
        filename,
        profileNames: profileIds
          .filter(id => profiles.find(p => p.id === id)?.preferred_catalog === filename)
          .map(id => profiles.find(p => p.id === id)?.name ?? id),
      }));
      setDecoderConflictOptions(options);
      dialogs.decoderConflict.open();
    } else if (catalogPath) {
      tlog.debug(`[Graph] carrying over local decoder to session → ${catalogPath}`);
      useSessionStore.getState().setSessionCatalogPath(sessionId, catalogPath);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionCatalogPath, sessionId, multiBusProfiles, sourceProfileId]);

  // Centralised IO picker handlers
  const ioPickerProps = useIOPickerHandlers({
    manager,
    closeDialog: () => dialogs.ioReaderPicker.close(),
    mergeOptions: (options) => mergeSerialConfig(useGraphStore.getState().serialConfig, options),
  });

  // ── Menu session control ──
  useMenuSessionControl({
    panelId: "graph",
    sessionState: {
      profileName: ioProfileName ?? null,
      isStreaming,
      isPaused,
      capabilities,
      joinerCount,
    },
    callbacks: {
      onPlay: () => {
        if (isPaused) {
          session.resume();
        } else if (isStopped && sessionReady) {
          session.start();
        }
      },
      onPause: () => {
        if (isStreaming && !isPaused) session.pause();
      },
      onStop: () => {
        if (isStreaming && !isPaused) session.pause();
      },
      onStopAll: () => {
        if (isStreaming) stopWatch();
      },
      onClear: clearData,
      onPicker: () => dialogs.ioReaderPicker.open(),
    },
  });

  // ── Initialise from settings ──
  useEffect(() => {
    if (settings) {
      initFromSettings(
        settings.decoder_dir,
        settings.default_read_profile,
      );
      setBufferCapacity(settings.graph_buffer_size ?? 10_000);
    }
  }, [settings, initFromSettings, setBufferCapacity]);

  // Load catalog list and saved layouts on mount
  useEffect(() => {
    if (decoderDir) {
      listCatalogs(decoderDir).then(setCatalogs).catch(console.error);
    }
    loadSavedLayouts();
  }, [decoderDir, loadSavedLayouts]);

  // Reload saved layouts when they change from other panels
  useEffect(() => {
    const promise = onStoreChanged((event) => {
      if (event.key === 'graph.layouts') loadSavedLayouts();
    });
    return () => { promise.then((unlisten) => unlisten()); };
  }, [loadSavedLayouts]);

  // ── Dialog handlers ──
  const handleCatalogChange = useCallback(async (path: string) => {
    await loadCatalog(path);
    if (sessionId) useSessionStore.getState().setSessionCatalogPath(sessionId, path);
  }, [loadCatalog, sessionId]);

  const openPanelConfig = useCallback((panelId: string) => {
    setConfiguringPanelId(panelId);
    dialogs.panelConfig.open();
  }, [dialogs.panelConfig]);

  const handleAddSignals = useCallback((panelId: string) => {
    setConfiguringPanelId(panelId);
    setReplacingSignalIndex(null);
    dialogs.panelConfig.close();
    dialogs.signalPicker.open();
  }, [dialogs]);

  const handleReplaceSignal = useCallback((panelId: string, signalIndex: number) => {
    setConfiguringPanelId(panelId);
    setReplacingSignalIndex(signalIndex);
    dialogs.panelConfig.close();
    dialogs.signalPicker.open();
  }, [dialogs]);

  return (
    <AppLayout
      topBar={
        <GraphTopBar
          ioProfile={ioProfile}
          ioProfiles={settings?.io_profiles ?? []}
          multiBusProfiles={sessionId ? multiBusProfiles : []}
          defaultReadProfileId={settings?.default_read_profile}
          sessionId={sessionId}
          ioState={readerState}
          isStreaming={isStreaming}
          isStopped={isStopped}
          supportsTimeRange={capabilities?.supports_time_range ?? false}
          onStop={stopWatch}
          onResume={resumeWithNewBuffer}
          onLeave={!isDetached ? handleLeave : undefined}
          onOpenIoReaderPicker={() => dialogs.ioReaderPicker.open()}
          catalogs={catalogs}
          catalogPath={catalogPath}
          onOpenCatalogPicker={() => dialogs.catalogPicker.open()}
          isWatching={isWatching}
          watchFrameCount={watchFrameCount}
          savedLayouts={savedLayouts}
          onSaveLayout={saveCurrentLayout}
          onLoadLayout={loadLayout}
          onDeleteLayout={deleteSavedLayout}
          catalogFilename={catalogFilenameFromPath(catalogPath)}
          rawViewMode={rawViewMode}
          onToggleRawView={handleToggleRawView}
          onOpenCandidates={() => dialogs.candidateSignals.open()}
          onOpenHypothesisExplorer={() => dialogs.hypothesisExplorer.open()}
        />
      }
    >
      {rawViewMode ? (
        <CodeView
          content={rawViewContent}
          onChange={setRawViewContent}
          placeholder="Paste a graph layout JSON here…"
        />
      ) : (
        <GraphGrid
          onOpenPanelConfig={openPanelConfig}
        />
      )}

      <CatalogPickerDialog
        isOpen={dialogs.catalogPicker.isOpen}
        onClose={() => dialogs.catalogPicker.close()}
        catalogs={catalogs}
        selectedPath={catalogPath}
        onSelect={handleCatalogChange}
        title="Select Graph Catalog"
      />

      <IoReaderPickerDialog
        {...ioPickerProps}
        isOpen={dialogs.ioReaderPicker.isOpen}
        onClose={() => dialogs.ioReaderPicker.close()}
        ioProfiles={settings?.io_profiles ?? []}
        selectedId={ioProfile}
        defaultId={settings?.default_read_profile}
        onSelect={setIoProfile}
      />

      <SignalPickerDialog
        isOpen={dialogs.signalPicker.isOpen}
        onClose={() => {
          dialogs.signalPicker.close();
          setReplacingSignalIndex(null);
          dialogs.panelConfig.open();
        }}
        panelId={configuringPanelId}
        replacingSignalIndex={replacingSignalIndex}
        onReplaceDone={() => setReplacingSignalIndex(null)}
      />

      <PanelConfigDialog
        isOpen={dialogs.panelConfig.isOpen}
        onClose={() => dialogs.panelConfig.close()}
        panelId={configuringPanelId}
        onAddSignals={handleAddSignals}
        onReplaceSignal={handleReplaceSignal}
      />

      <CandidateSignalsDialog
        isOpen={dialogs.candidateSignals.isOpen}
        onClose={() => dialogs.candidateSignals.close()}
      />

      <HypothesisExplorerDialog
        isOpen={dialogs.hypothesisExplorer.isOpen}
        onClose={() => dialogs.hypothesisExplorer.close()}
      />

      <DecoderConflictDialog
        isOpen={dialogs.decoderConflict.isOpen}
        onClose={() => dialogs.decoderConflict.close()}
        options={decoderConflictOptions}
        onSelect={(filename) => {
          const path = buildCatalogPath(filename, decoderDir);
          loadCatalog(path).catch(console.error);
          if (sessionId) useSessionStore.getState().setSessionCatalogPath(sessionId, path);
        }}
        onSkip={() => {
          // User chose "None" — no decoder for this session
        }}
      />
    </AppLayout>
  );
}
