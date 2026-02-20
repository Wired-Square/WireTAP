// ui/src/apps/graph/Graph.tsx

import { useEffect, useState, useCallback, useRef } from "react";
import { useSettings } from "../../hooks/useSettings";
import { useGraphStore, type SignalValueEntry } from "../../stores/graphStore";
import { useIOSessionManager } from "../../hooks/useIOSessionManager";
import { useIOPickerHandlers } from "../../hooks/useIOPickerHandlers";
import { listCatalogs, type CatalogMetadata } from "../../api/catalog";
import { mergeSerialConfig } from "../../utils/sessionConfigMerge";
import { catalogFilenameFromPath } from "../../utils/graphLayouts";
import AppLayout from "../../components/AppLayout";
import GraphTopBar from "./views/GraphTopBar";
import GraphGrid from "./views/GraphGrid";
import CatalogPickerDialog from "../../dialogs/CatalogPickerDialog";
import IoReaderPickerDialog from "../../dialogs/IoReaderPickerDialog";
import SignalPickerDialog from "./dialogs/SignalPickerDialog";
import PanelConfigDialog from "./dialogs/PanelConfigDialog";
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

  const dialogs = useDialogManager([
    'ioReaderPicker',
    'catalogPicker',
    'signalPicker',
    'panelConfig',
  ] as const);

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

  // Layout persistence
  const savedLayouts = useGraphStore((s) => s.savedLayouts);
  const saveCurrentLayout = useGraphStore((s) => s.saveCurrentLayout);
  const loadLayout = useGraphStore((s) => s.loadLayout);
  const deleteSavedLayout = useGraphStore((s) => s.deleteSavedLayout);
  const loadSavedLayouts = useGraphStore((s) => s.loadSavedLayouts);

  const decoderDir = settings?.decoder_dir ?? "";

  // ── Frame batching ──
  const pendingValuesRef = useRef<SignalValueEntry[]>([]);
  const flushScheduledRef = useRef(false);
  const pushSignalValuesRef = useRef(pushSignalValues);
  const UI_UPDATE_INTERVAL_MS = 100;

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

    for (const f of receivedFrames) {
      const timestamp = f.timestamp_us !== undefined ? f.timestamp_us / 1_000_000 : Date.now() / 1000;
      const maskedFrameId = mask !== undefined ? (f.frame_id & mask) : f.frame_id;
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
    // Multi-bus state
    multiBusProfiles,
    // Derived state
    isStreaming,
    isStopped,
    capabilities,
    isDetached,
    handleLeave,
    resumeWithNewBuffer,
    // Watch state
    isWatching,
    watchFrameCount,
    stopWatch,
  } = manager;

  const { sessionId, state: readerState } = session;

  // Centralised IO picker handlers
  const ioPickerProps = useIOPickerHandlers({
    manager,
    closeDialog: () => dialogs.ioReaderPicker.close(),
    mergeOptions: (options) => mergeSerialConfig(useGraphStore.getState().serialConfig, options),
    getReinitializeOptions: () => ({
      frameIdBigEndian: useGraphStore.getState().serialConfig?.frame_id_byte_order === "big",
    }),
  });

  // ── Initialise from settings ──
  useEffect(() => {
    if (settings) {
      initFromSettings(
        settings.default_catalog ?? undefined,
        settings.decoder_dir,
        settings.default_read_profile,
      );
    }
  }, [settings, initFromSettings]);

  // Load catalog list and saved layouts on mount
  useEffect(() => {
    if (decoderDir) {
      listCatalogs(decoderDir).then(setCatalogs).catch(console.error);
    }
    loadSavedLayouts();
  }, [decoderDir, loadSavedLayouts]);

  // ── Dialog handlers ──
  const handleCatalogChange = useCallback(async (path: string) => {
    await loadCatalog(path);
  }, [loadCatalog]);

  const openSignalPicker = useCallback((panelId: string) => {
    setConfiguringPanelId(panelId);
    dialogs.signalPicker.open();
  }, [dialogs.signalPicker]);

  const openPanelConfig = useCallback((panelId: string) => {
    setConfiguringPanelId(panelId);
    dialogs.panelConfig.open();
  }, [dialogs.panelConfig]);

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
          defaultCatalogFilename={settings?.default_catalog}
          onOpenCatalogPicker={() => dialogs.catalogPicker.open()}
          isWatching={isWatching}
          watchFrameCount={watchFrameCount}
          savedLayouts={savedLayouts}
          onSaveLayout={saveCurrentLayout}
          onLoadLayout={loadLayout}
          onDeleteLayout={deleteSavedLayout}
          catalogFilename={catalogFilenameFromPath(catalogPath)}
        />
      }
    >
      <GraphGrid
        onOpenSignalPicker={openSignalPicker}
        onOpenPanelConfig={openPanelConfig}
      />

      <CatalogPickerDialog
        isOpen={dialogs.catalogPicker.isOpen}
        onClose={() => dialogs.catalogPicker.close()}
        catalogs={catalogs}
        selectedPath={catalogPath}
        defaultFilename={settings?.default_catalog}
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
        onClose={() => dialogs.signalPicker.close()}
        panelId={configuringPanelId}
      />

      <PanelConfigDialog
        isOpen={dialogs.panelConfig.isOpen}
        onClose={() => dialogs.panelConfig.close()}
        panelId={configuringPanelId}
      />
    </AppLayout>
  );
}
