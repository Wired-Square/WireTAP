// ui/src/apps/modbus/Modbus.tsx
//
// Main Modbus app component.
// Owns Modbus polling (TCP/RTU), displays register values with decoded signals.
// Shares session with decoder so both apps can work on the same data.

import { useEffect, useMemo, useState, useCallback, useRef } from "react";
import { Server, Settings as SettingsIcon, Play, Square } from "lucide-react";
import { dataViewContainer } from "../../styles";
import { useSettings, getDisplayFrameIdFormat } from "../../hooks/useSettings";
import { useIOSessionManager } from "../../hooks/useIOSessionManager";
import { useIOSourcePickerHandlers } from "../../hooks/useIOSourcePickerHandlers";
import { useMenuSessionControl } from "../../hooks/useMenuSessionControl";
import { useSessionStore } from "../../stores/sessionStore";
import { useModbusStore } from "./stores/modbusStore";
import { pauseSourcePolling, resumeSourcePolling } from "../../api/io";
import { listCatalogs, type CatalogMetadata } from "../../api/catalog";
import { tlog } from "../../api/settings";
import AppLayout from "../../components/AppLayout";
import IoSourcePickerDialog from "../../dialogs/IoSourcePickerDialog";
import CatalogPickerDialog from "../../dialogs/CatalogPickerDialog";
import FramePickerDialog from "../../dialogs/FramePickerDialog";
import ModbusTopBar from "./views/ModbusTopBar";
import ModbusRegistersView from "./views/ModbusRegistersView";
import ModbusConfigView from "./views/ModbusConfigView";
import type { FrameMessage } from "../../types/frame";

export default function Modbus() {
  const { settings } = useSettings();
  const displayFrameIdFormat = getDisplayFrameIdFormat();
  const decoderDir = settings?.decoder_dir ?? null;

  // Dialog state
  const [ioPickerOpen, setIoPickerOpen] = useState(false);
  const [catalogPickerOpen, setCatalogPickerOpen] = useState(false);
  const [framePickerOpen, setFramePickerOpen] = useState(false);
  const [catalogs, setCatalogs] = useState<CatalogMetadata[]>([]);
  const [isPolling, setIsPolling] = useState(true);

  // Modbus store
  const catalogPath = useModbusStore((s) => s.catalogPath);
  const pollGroups = useModbusStore((s) => s.pollGroups);
  const modbusConfig = useModbusStore((s) => s.modbusConfig);
  const frames = useModbusStore((s) => s.frames);
  const selectedFrames = useModbusStore((s) => s.selectedFrames);
  const transportMode = useModbusStore((s) => s.transportMode);
  const rtuConfig = useModbusStore((s) => s.rtuConfig);
  const ioProfile = useModbusStore((s) => s.ioProfile);
  const registerVersion = useModbusStore((s) => s.registerVersion);
  const activeTab = useModbusStore((s) => s.activeTab);
  const loadCatalog = useModbusStore((s) => s.loadCatalog);
  const setTransportMode = useModbusStore((s) => s.setTransportMode);
  const setRtuConfig = useModbusStore((s) => s.setRtuConfig);
  const setIoProfile = useModbusStore((s) => s.setIoProfile);
  const setActiveTab = useModbusStore((s) => s.setActiveTab);
  const toggleFrameSelection = useModbusStore((s) => s.toggleFrameSelection);
  const selectAllFrames = useModbusStore((s) => s.selectAllFrames);
  const deselectAllFrames = useModbusStore((s) => s.deselectAllFrames);
  const clearState = useModbusStore((s) => s.clearState);

  // Frame handler
  const handleFrames = useCallback((incomingFrames: FrameMessage[]) => {
    useModbusStore.getState().processFrames(incomingFrames);
  }, []);

  const handleError = useCallback((error: string) => {
    tlog.info(`[Modbus] Session error: ${error}`);
  }, []);

  // Session manager
  const manager = useIOSessionManager({
    appName: "modbus",
    ioProfiles: settings?.io_profiles ?? [],
    store: { ioProfile, setIoProfile },
    requireFrames: true,
    onFrames: handleFrames,
    onError: handleError,
    onBeforeWatch: clearState,
    onBeforeMultiWatch: clearState,
  });

  const {
    session,
    effectiveSessionId: sessionId,
    isStreaming,
    isStopped,
    stopWatch,
    watchSource,
    sourceProfileId,
    multiBusProfiles,
  } = manager;


  // IO source picker handlers
  const ioPickerProps = useIOSourcePickerHandlers({
    manager,
    closeDialog: () => setIoPickerOpen(false),
    mergeOptions: (options) => {
      const state = useModbusStore.getState();
      // Inject Modbus poll groups into session creation
      if (state.modbusPollsJson) {
        return { ...options, modbusPollsJson: state.modbusPollsJson };
      }
      return options;
    },
  });

  // Menu session control
  useMenuSessionControl({
    panelId: "modbus",
    sessionState: {
      profileName: null,
      isStreaming,
      isPaused: false,
      capabilities: session.capabilities ?? null,
      joinerCount: 0,
    },
    callbacks: {
      onStop: stopWatch,
      onPicker: () => setIoPickerOpen(true),
    },
  });

  // Load catalog list when decoder directory changes
  useEffect(() => {
    if (decoderDir) {
      listCatalogs(decoderDir).then(setCatalogs).catch(() => setCatalogs([]));
    }
  }, [decoderDir]);

  // Track last-used source profile IDs so we can reconnect after stop
  const lastProfileIdsRef = useRef<string[]>([]);
  useEffect(() => {
    if (multiBusProfiles.length > 0) {
      lastProfileIdsRef.current = multiBusProfiles;
    } else if (sourceProfileId) {
      lastProfileIdsRef.current = [sourceProfileId];
    }
  }, [multiBusProfiles, sourceProfileId]);

  // Derive the source profile ID for per-source polling control
  const sourceProfileForPolling = multiBusProfiles.length > 0
    ? multiBusProfiles[0]
    : sourceProfileId
      ? sourceProfileId
      : lastProfileIdsRef.current[0] ?? null;

  // Reset polling state when session starts/stops
  useEffect(() => {
    if (isStreaming) setIsPolling(true);
  }, [isStreaming]);

  // Reconnect with poll groups — used for resume and catalog change while connected.
  const reconnectWithPolls = useCallback(async () => {
    const { modbusPollsJson } = useModbusStore.getState();
    if (!modbusPollsJson) return;

    // Use the real source profile IDs, falling back to last-known IDs
    const profileIds = multiBusProfiles.length > 0
      ? multiBusProfiles
      : sourceProfileId
        ? [sourceProfileId]
        : lastProfileIdsRef.current;

    if (profileIds.length === 0) return;

    tlog.debug(`[Modbus] Reconnecting with ${JSON.parse(modbusPollsJson).length} poll groups`);
    try {
      await watchSource(profileIds, { modbusPollsJson });
    } catch (err) {
      tlog.info(`[Modbus] Failed to reconnect: ${err}`);
    }
  }, [watchSource, multiBusProfiles, sourceProfileId]);

  // Watch session catalog path — auto-load when set externally (e.g. by decoder)
  const sessionCatalogPath = useSessionStore((s) => {
    if (!sessionId) return undefined;
    const sess = s.sessions[sessionId];
    if (!sess) return undefined;
    return sess.catalogPath;
  });

  useEffect(() => {
    if (sessionCatalogPath && sessionCatalogPath !== catalogPath) {
      tlog.debug(`[Modbus] session catalogue changed externally → ${sessionCatalogPath}`);
      loadCatalog(sessionCatalogPath).catch((err) => {
        tlog.info(`[Modbus] Failed to load catalogue: ${err}`);
      });
    }
  }, [sessionCatalogPath, catalogPath, loadCatalog]);

  // Handle catalog selection from picker
  const handleCatalogSelect = useCallback(async (path: string) => {
    try {
      await loadCatalog(path);
      // Set on session so decoder picks it up
      if (sessionId) {
        useSessionStore.getState().setSessionCatalogPath(sessionId, path);
      }
      // Reinitialise session with new poll groups
      await reconnectWithPolls();
    } catch (err) {
      tlog.info(`[Modbus] Failed to load catalogue: ${err}`);
    }
  }, [loadCatalog, sessionId, reconnectWithPolls]);

  // Build FrameInfo list for FramePickerDialog (composite keys)
  const pickerFrameList = useMemo(
    () => Array.from(frames.entries())
      .map(([fk, f]) => ({
        id: fk,
        len: f.len,
        isExtended: false,
        bus: f.bus,
        protocol: 'modbus' as const,
      }))
      .sort((a, b) => {
        const aNum = parseInt(a.id.split(':')[1]);
        const bNum = parseInt(b.id.split(':')[1]);
        return aNum - bNum;
      }),
    [frames]
  );

  // Total register count from poll groups
  const totalRegisters = useMemo(
    () => pollGroups.reduce((sum, pg) => sum + pg.count, 0),
    [pollGroups]
  );

  return (
    <AppLayout
      topBar={
        <ModbusTopBar
          ioProfiles={settings?.io_profiles ?? []}
          ioProfile={ioProfile}
          sessionId={sessionId}
          isStreaming={isStreaming}
          isStopped={isStopped}
          ioState={session.state}
          onOpenIoPicker={() => setIoPickerOpen(true)}
          onStop={stopWatch}
          onResume={reconnectWithPolls}
          transportMode={transportMode}
          catalogs={catalogs}
          catalogPath={catalogPath}
          onOpenCatalogPicker={() => setCatalogPickerOpen(true)}
          pollGroupCount={pollGroups.length}
          registerCount={totalRegisters}
          frameCount={frames.size}
          selectedFrameCount={selectedFrames.size}
          onOpenFramePicker={() => setFramePickerOpen(true)}
        />
      }
    >
      <div className={`flex-1 flex flex-col min-h-0 ${dataViewContainer}`}>
        {/* Tab bar with polling controls */}
        <div className="flex items-center border-b border-[color:var(--border-default)] bg-[var(--bg-surface)]">
          <button
            onClick={() => setActiveTab('registers')}
            className={`flex items-center gap-1.5 px-4 py-1.5 text-xs font-medium transition-colors ${
              activeTab === 'registers'
                ? 'text-[color:var(--text-primary)] border-b-2 border-amber-400'
                : 'text-[color:var(--text-muted)] hover:text-[color:var(--text-secondary)]'
            }`}
          >
            <Server size={12} />
            Registers
          </button>
          <button
            onClick={() => setActiveTab('config')}
            className={`flex items-center gap-1.5 px-4 py-1.5 text-xs font-medium transition-colors ${
              activeTab === 'config'
                ? 'text-[color:var(--text-primary)] border-b-2 border-amber-400'
                : 'text-[color:var(--text-muted)] hover:text-[color:var(--text-secondary)]'
            }`}
          >
            <SettingsIcon size={12} />
            Config
          </button>

          {/* Polling controls — right side */}
          <div className="ml-auto flex items-center gap-2 px-3">
            {isStreaming && isPolling && sessionId && sourceProfileForPolling ? (
              <button
                onClick={() => {
                  pauseSourcePolling(sessionId, sourceProfileForPolling)
                    .then(() => setIsPolling(false))
                    .catch((e: unknown) => tlog.info(`[Modbus] Pause failed: ${e}`));
                }}
                className="flex items-center gap-1.5 px-3 py-1 rounded text-xs font-medium bg-red-600/20 text-red-400 hover:bg-red-600/30 transition-colors"
                title="Pause polling"
              >
                <Square size={10} fill="currentColor" />
                Pause
              </button>
            ) : isStreaming && !isPolling && sessionId && sourceProfileForPolling ? (
              <button
                onClick={() => {
                  resumeSourcePolling(sessionId, sourceProfileForPolling)
                    .then(() => setIsPolling(true))
                    .catch((e: unknown) => tlog.info(`[Modbus] Resume failed: ${e}`));
                }}
                className="flex items-center gap-1.5 px-3 py-1 rounded text-xs font-medium bg-green-600/20 text-green-400 hover:bg-green-600/30 transition-colors"
                title="Resume polling"
              >
                <Play size={10} fill="currentColor" />
                Poll
              </button>
            ) : !isStreaming && pollGroups.length > 0 ? (
              <button
                onClick={reconnectWithPolls}
                className="flex items-center gap-1.5 px-3 py-1 rounded text-xs font-medium bg-green-600/20 text-green-400 hover:bg-green-600/30 transition-colors"
                title="Start polling"
              >
                <Play size={10} fill="currentColor" />
                Poll
              </button>
            ) : null}
          </div>
        </div>

        {/* Tab content */}
        {activeTab === 'registers' && (
          <ModbusRegistersView
            frames={frames}
            selectedFrames={selectedFrames}
            pollGroups={pollGroups}
            registerVersion={registerVersion}
            displayFrameIdFormat={displayFrameIdFormat}
          />
        )}
        {activeTab === 'config' && (
          <ModbusConfigView
            transportMode={transportMode}
            rtuConfig={rtuConfig}
            modbusConfig={modbusConfig}
            onSetTransportMode={setTransportMode}
            onSetRtuConfig={setRtuConfig}
          />
        )}
      </div>

      {/* IO Source Picker Dialog */}
      <IoSourcePickerDialog
        isOpen={ioPickerOpen}
        onClose={() => setIoPickerOpen(false)}
        ioProfiles={settings?.io_profiles ?? []}
        selectedId={ioProfile ?? null}
        defaultId={settings?.default_read_profile}
        onSelect={() => {}}
        {...ioPickerProps}
        defaultDir={settings?.dump_dir}
      />

      {/* Catalog Picker Dialog */}
      {catalogPickerOpen && (
        <CatalogPickerDialog
          isOpen={catalogPickerOpen}
          onClose={() => setCatalogPickerOpen(false)}
          catalogs={catalogs}
          selectedPath={catalogPath}
          onSelect={handleCatalogSelect}
        />
      )}

      {/* Frame Picker Dialog */}
      <FramePickerDialog
        isOpen={framePickerOpen}
        onClose={() => setFramePickerOpen(false)}
        frames={pickerFrameList}
        selectedFrames={selectedFrames}
        onToggleFrame={toggleFrameSelection}
        onBulkSelect={() => {}}
        displayFrameIdFormat={displayFrameIdFormat}
        onSelectAll={selectAllFrames}
        onDeselectAll={deselectAllFrames}
      />
    </AppLayout>
  );
}
