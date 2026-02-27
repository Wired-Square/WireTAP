// src/apps/query/Query.tsx
//
// Query app for querying PostgreSQL data sources to answer analytical questions
// about CAN bus history. Uses the session system so other apps can share the
// session to visualise discovered timeslices.

import { useCallback, useEffect, useMemo, useState } from "react";
import { useSettings } from "../../hooks/useSettings";
import { useIOSessionManager } from "../../hooks/useIOSessionManager";
import { useIOPickerHandlers } from "../../hooks/useIOPickerHandlers";
import { useMenuSessionControl } from "../../hooks/useMenuSessionControl";
import { useQueryStore } from "./stores/queryStore";
import { useSessionStore } from "../../stores/sessionStore";
import { useSettingsStore } from "../settings/stores/settingsStore";
import { buildCatalogPath } from "../../utils/catalogUtils";

import { useDialogManager } from "../../hooks/useDialogManager";
import { useQueryHandlers } from "./hooks/useQueryHandlers";
import type { FrameMessage } from "../../types/frame";
import type { PlaybackPosition } from "../../api/io";
import type { CatalogMetadata } from "../../api/catalog";
import { listCatalogs } from "../../api/catalog";
import { listBuffers, type BufferMetadata } from "../../api/buffer";

import { getFavoritesForProfile, type TimeRangeFavorite } from "../../utils/favorites";
import { loadCatalog } from "../../utils/catalogParser";
import type { TimeBounds } from "../../components/TimeBoundsInput";
import AppLayout from "../../components/AppLayout";
import AppTabView, { type TabDefinition, type ProtocolBadge } from "../../components/AppTabView";
import QueryTopBar from "./views/QueryTopBar";
import QueryBuilderPanel from "./views/QueryBuilderPanel";
import QueuePanel from "./views/QueuePanel";
import ResultsPanel from "./views/ResultsPanel";
import StatsPanel from "./views/StatsPanel";
import IoReaderPickerDialog from "../../dialogs/IoReaderPickerDialog";
import ErrorDialog from "../../dialogs/ErrorDialog";
import CatalogPickerDialog from "../../dialogs/CatalogPickerDialog";
import AddBookmarkDialog from "../../dialogs/AddBookmarkDialog";

export default function Query() {
  const { settings } = useSettings();

  // Tab state
  const [activeTab, setActiveTab] = useState<string>("query");

  // Query store selectors
  const ioProfile = useQueryStore((s) => s.ioProfile);
  const setIoProfile = useQueryStore((s) => s.setIoProfile);
  const error = useQueryStore((s) => s.error);
  const setError = useQueryStore((s) => s.setError);
  const queue = useQueryStore((s) => s.queue);
  const selectedQueryId = useQueryStore((s) => s.selectedQueryId);
  const catalogPath = useQueryStore((s) => s.catalogPath);
  const setCatalogPath = useQueryStore((s) => s.setCatalogPath);

  const setParsedCatalog = useQueryStore((s) => s.setParsedCatalog);

  // Catalog state
  const [catalogs, setCatalogs] = useState<CatalogMetadata[]>([]);

  // Favourites state (bookmarks)
  const [favourites, setFavourites] = useState<TimeRangeFavorite[]>([]);

  // Buffer sources state
  const [buffers, setBuffers] = useState<BufferMetadata[]>([]);
  const [selectedBufferId, setSelectedBufferId] = useState<string | null>(null);

  // Load available buffers on mount
  useEffect(() => {
    const loadBuffers = async () => {
      try {
        const all = await listBuffers();
        // Only show frame buffers with data
        setBuffers(all.filter((b) => b.buffer_type === "frames" && b.count > 0));
      } catch (e) {
        console.error("Failed to load buffers:", e);
      }
    };
    loadBuffers();
  }, []);

  // Time bounds state (for query filtering)
  const [timeBounds, setTimeBounds] = useState<TimeBounds>({
    startTime: "",
    endTime: "",
    maxFrames: undefined,
    timezoneMode: "local",
  });

  // Computed values
  const queueCount = queue.length;
  const pendingCount = queue.filter((q) => q.status === "pending").length;
  const selectedQuery = queue.find((q) => q.id === selectedQueryId) ?? null;
  const selectedQueryResultCount = selectedQuery?.results
    ? (selectedQuery.results as unknown[]).length
    : 0;

  // Dialog management
  const dialogs = useDialogManager([
    "ioReaderPicker",
    "error",
    "catalogPicker",
    "addBookmark",
  ] as const);

  // Load catalogs when decoder directory changes
  useEffect(() => {
    const decoderDir = settings?.decoder_dir;
    if (!decoderDir) return;

    const loadCatalogList = async () => {
      try {
        const list = await listCatalogs(decoderDir);
        setCatalogs(list);
      } catch (e) {
        console.error("Failed to load catalog list:", e);
      }
    };
    loadCatalogList();
  }, [settings?.decoder_dir]);

  // Load and parse catalog when path changes
  useEffect(() => {
    if (!catalogPath) {
      setParsedCatalog(null);
      return;
    }

    const loadParsedCatalog = async () => {
      try {
        const parsed = await loadCatalog(catalogPath);
        setParsedCatalog(parsed);
      } catch (e) {
        console.error("Failed to load catalog:", e);
        setParsedCatalog(null);
      }
    };
    loadParsedCatalog();
  }, [catalogPath, setParsedCatalog]);


  // Filter profiles to postgres only
  const postgresProfiles = useMemo(
    () => (settings?.io_profiles ?? []).filter((p) => p.kind === "postgres"),
    [settings?.io_profiles]
  );

  // Frame callback - frames arrive when user clicks a result row to ingest
  const handleFrames = useCallback((_frames: FrameMessage[]) => {
    // Frames are handled by the session system and shared with other apps
  }, []);

  // Error callback
  const handleError = useCallback(
    (errorMsg: string) => {
      setError(errorMsg);
      dialogs.error.open();
    },
    [setError, dialogs.error]
  );

  // Time update callback
  const handleTimeUpdate = useCallback((_position: PlaybackPosition) => {
    // Time updates are handled by session system
  }, []);

  // Session manager - used when clicking result rows to ingest data
  const manager = useIOSessionManager({
    appName: "query",
    ioProfiles: postgresProfiles,
    store: { ioProfile, setIoProfile },
    onFrames: handleFrames,
    onError: handleError,
    onTimeUpdate: handleTimeUpdate,
  });

  // Destructure session state and actions from manager
  const {
    watchSingleSource,
    stopWatch,
    ioProfileName,
    sourceProfileId,
    isStreaming,
    isPaused,
    isStopped,
    joinerCount,
    handleLeave,
    capabilities,
    session,
  } = manager;

  // Subscribe to session's catalogPath. Returns undefined when session doesn't exist
  // in the store yet, null when it exists with no decoder, or a string path.
  const sessionCatalogPath = useSessionStore((s) => {
    const sid = session.sessionId;
    if (!sid) return undefined;
    const sess = s.sessions[sid];
    if (!sess) return undefined;
    return sess.catalogPath;
  });

  // Cross-app decoder sync: when another app (or Session Manager) changes the
  // session's catalogPath to a non-null value, update the local store.
  useEffect(() => {
    if (!sessionCatalogPath || sessionCatalogPath === catalogPath) return;
    setCatalogPath(sessionCatalogPath);
  }, [sessionCatalogPath, catalogPath, setCatalogPath]);

  // Auto-set session decoder from source profile's preferred_catalog when a new session
  // starts. Fires when sessionCatalogPath transitions from undefined to null.
  useEffect(() => {
    if (sessionCatalogPath !== null) return;
    const sid = session.sessionId;
    if (!sid) return;

    if (sourceProfileId) {
      const profiles = useSettingsStore.getState().ioProfiles.profiles;
      const preferred = profiles.find(p => p.id === sourceProfileId)?.preferred_catalog;
      if (preferred) {
        const decoderDir = settings?.decoder_dir;
        const path = buildCatalogPath(preferred, decoderDir);
        setCatalogPath(path);
        useSessionStore.getState().setSessionCatalogPath(sid, path);
        return;
      }
    }

    // No preferred decoder from profile — carry over any locally loaded decoder
    if (catalogPath) {
      useSessionStore.getState().setSessionCatalogPath(sid, catalogPath);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionCatalogPath, session.sessionId, sourceProfileId]);

  // Determine active source — postgres profile or buffer (mutually exclusive)
  const hasSource = !!sourceProfileId || !!selectedBufferId;

  // Clear buffer selection when a postgres profile is selected, and vice versa
  useEffect(() => {
    if (sourceProfileId && selectedBufferId) {
      setSelectedBufferId(null);
    }
  }, [sourceProfileId, selectedBufferId]);

  // Load favourites when source profile changes
  useEffect(() => {
    if (!sourceProfileId) {
      setFavourites([]);
      return;
    }

    const loadFavourites = async () => {
      try {
        const favs = await getFavoritesForProfile(sourceProfileId);
        setFavourites(favs);
      } catch (e) {
        console.error("Failed to load favourites:", e);
      }
    };
    loadFavourites();
  }, [sourceProfileId]);

  // ── Menu session control ──
  useMenuSessionControl({
    panelId: "query",
    sessionState: {
      profileName: ioProfileName ?? null,
      isStreaming,
      isPaused,
      capabilities,
      joinerCount,
    },
    callbacks: {
      onPicker: () => dialogs.ioReaderPicker.open(),
    },
  });

  // Centralised IO picker dialog handlers (connect, skip, etc.)
  const ioPickerProps = useIOPickerHandlers({
    manager,
    closeDialog: () => dialogs.ioReaderPicker.close(),
  });

  // Compose all handlers using the orchestrator hook
  const handlers = useQueryHandlers({
    watchSingleSource,
    stopWatch,
    sourceProfileId,
    openIoReaderPicker: dialogs.ioReaderPicker.open,
    openCatalogPicker: dialogs.catalogPicker.open,
    closeCatalogPicker: dialogs.catalogPicker.close,
    openErrorDialog: dialogs.error.open,
    closeErrorDialog: dialogs.error.close,
    openAddBookmarkDialog: dialogs.addBookmark.open,
    closeAddBookmarkDialog: dialogs.addBookmark.close,
    setActiveTab,
    setFavourites,
  });

  // Get time range from selected query results for bookmarking
  const getSelectedQueryTimeRange = useCallback(() => {
    if (!selectedQuery?.results || (selectedQuery.results as unknown[]).length === 0) {
      return null;
    }
    const results = selectedQuery.results as { timestamp_us: number }[];
    const timestamps = results.map((r) => r.timestamp_us);
    return {
      minTimestampUs: Math.min(...timestamps),
      maxTimestampUs: Math.max(...timestamps),
    };
  }, [selectedQuery]);

  // Handle ingest all results wrapper (gets time range from selected query)
  const handleIngestAllResultsWrapper = useCallback(async () => {
    const timeRange = getSelectedQueryTimeRange();
    if (timeRange) {
      await handlers.handleIngestAllResults(
        timeRange.minTimestampUs,
        timeRange.maxTimestampUs
      );
    }
  }, [handlers, getSelectedQueryTimeRange]);

  // Handle bookmark query wrapper
  const handleBookmarkQueryWrapper = useCallback(() => {
    handlers.handleBookmarkQuery(selectedQuery !== null);
  }, [handlers, selectedQuery]);

  // Handle export query wrapper
  const handleExportQueryWrapper = useCallback(() => {
    handlers.handleExportQuery(selectedQuery?.id);
  }, [handlers, selectedQuery]);

  // Handle time bounds change wrapper
  const handleTimeBoundsChangeWrapper = useCallback(
    (bounds: TimeBounds) => {
      handlers.handleTimeBoundsChange(bounds, setTimeBounds);
    },
    [handlers]
  );

  // Get bookmark time range for the dialog
  const bookmarkTimeRange = useMemo(() => {
    const range = getSelectedQueryTimeRange();
    if (!range) return { startTime: "", endTime: "" };
    return {
      startTime: new Date(range.minTimestampUs / 1000).toISOString().slice(0, 19),
      endTime: new Date(range.maxTimestampUs / 1000).toISOString().slice(0, 19),
    };
  }, [getSelectedQueryTimeRange]);

  // Tab definitions
  const tabs: TabDefinition[] = useMemo(
    () => [
      { id: "query", label: "Query" },
      {
        id: "queue",
        label: "Queue",
        count: queueCount > 0 ? queueCount : undefined,
        countColor: pendingCount > 0 ? ("orange" as const) : ("green" as const),
      },
      {
        id: "results",
        label: "Results",
        count: selectedQueryResultCount > 0 ? selectedQueryResultCount : undefined,
        countColor: "green" as const,
      },
      { id: "stats", label: "Stats" },
    ],
    [queueCount, pendingCount, selectedQueryResultCount]
  );

  // Protocol badge for data source
  const protocolBadges: ProtocolBadge[] = useMemo(() => {
    if (selectedBufferId) return [{ label: "Buffer", color: "amber" as const }];
    if (sourceProfileId) return [{ label: "PostgreSQL", color: "blue" as const }];
    return [];
  }, [sourceProfileId, selectedBufferId]);

  return (
    <AppLayout
      topBar={
        <QueryTopBar
          ioProfiles={postgresProfiles}
          ioProfile={ioProfile}
          defaultReadProfileId={settings?.default_read_profile}
          catalogs={catalogs}
          catalogPath={catalogPath}
          onOpenCatalogPicker={() => dialogs.catalogPicker.open()}
          onOpenIoReaderPicker={() => dialogs.ioReaderPicker.open()}
          isStreaming={isStreaming || hasSource}
          isStopped={isStopped}
          supportsTimeRange={capabilities?.supports_time_range ?? false}
          onStop={handlers.handleStopWatch}
          onResume={session.start}
          onLeave={handleLeave}
        />
      }
    >
      {/* Tab view: Query Builder / Queue / Results */}
      <AppTabView
        tabs={tabs}
        activeTab={activeTab}
        onTabChange={setActiveTab}
        protocolLabel="DB"
        protocolBadges={protocolBadges}
        isStreaming={isStreaming || hasSource}
        contentArea={{ className: "p-0" }}
      >
        {activeTab === "query" && (
          <QueryBuilderPanel
            profileId={sourceProfileId}
            bufferId={selectedBufferId}
            disabled={!hasSource}
            favourites={favourites}
            timeBounds={timeBounds}
            onTimeBoundsChange={handleTimeBoundsChangeWrapper}
            buffers={buffers}
            onSelectBuffer={setSelectedBufferId}
          />
        )}
        {activeTab === "queue" && (
          <QueuePanel
            onSelectQuery={handlers.handleSelectQuery}
            onRemoveQuery={handlers.handleRemoveQuery}
          />
        )}
        {activeTab === "results" && (
          <ResultsPanel
            selectedQuery={selectedQuery}
            onIngestEvent={handlers.handleIngestAroundEvent}
            onIngestAll={handleIngestAllResultsWrapper}
            onExport={handleExportQueryWrapper}
            onBookmark={handleBookmarkQueryWrapper}
          />
        )}
        {activeTab === "stats" && (
          selectedBufferId
            ? <div className="flex flex-col items-center justify-center h-full p-8 text-center">
                <p className="text-xs text-[color:var(--text-muted)]">
                  Stats are only available for PostgreSQL sources.
                </p>
              </div>
            : <StatsPanel profileId={sourceProfileId} />
        )}
      </AppTabView>

      {/* IO Reader Picker Dialog - connect mode for database selection */}
      <IoReaderPickerDialog
        mode="connect"
        {...ioPickerProps}
        isOpen={dialogs.ioReaderPicker.isOpen}
        onClose={() => dialogs.ioReaderPicker.close()}
        ioProfiles={postgresProfiles}
        selectedId={sourceProfileId}
        defaultId={settings?.default_read_profile}
        onSelect={setIoProfile}
      />

      {/* Error Dialog */}
      <ErrorDialog
        isOpen={dialogs.error.isOpen || error !== null}
        title="Query Error"
        message={error || "An error occurred"}
        onClose={handlers.handleCloseError}
      />

      {/* Catalog Picker Dialog */}
      <CatalogPickerDialog
        isOpen={dialogs.catalogPicker.isOpen}
        onClose={() => dialogs.catalogPicker.close()}
        catalogs={catalogs}
        selectedPath={catalogPath}
        onSelect={(path: string) => {
          handlers.handleCatalogChange(path);
          const sid = session.sessionId;
          if (sid) useSessionStore.getState().setSessionCatalogPath(sid, path);
        }}
      />

      {/* Add Bookmark Dialog */}
      <AddBookmarkDialog
        isOpen={dialogs.addBookmark.isOpen}
        frameId={0}
        frameTime={bookmarkTimeRange.startTime}
        onClose={() => dialogs.addBookmark.close()}
        onSave={handlers.handleSaveBookmark}
      />
    </AppLayout>
  );
}
