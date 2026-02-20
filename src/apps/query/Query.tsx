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
import { useDialogManager } from "../../hooks/useDialogManager";
import { useQueryHandlers } from "./hooks/useQueryHandlers";
import type { FrameMessage } from "../../types/frame";
import type { PlaybackPosition } from "../../api/io";
import type { CatalogMetadata } from "../../api/catalog";
import { listCatalogs } from "../../api/catalog";
import { resolveDefaultCatalogPath } from "../../utils/catalogUtils";
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

  // Auto-load default catalog when catalogs list and settings are available
  useEffect(() => {
    if (!settings?.default_catalog || catalogs.length === 0) return;
    if (catalogPath) return; // Preserve user's manual selection

    const defaultPath = resolveDefaultCatalogPath(settings.default_catalog, catalogs);
    if (defaultPath) {
      setCatalogPath(defaultPath);
    }
  }, [settings?.default_catalog, catalogs, catalogPath, setCatalogPath]);

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

  // Protocol badge for PostgreSQL
  const protocolBadges: ProtocolBadge[] = useMemo(
    () => (sourceProfileId ? [{ label: "PostgreSQL", color: "blue" as const }] : []),
    [sourceProfileId]
  );

  return (
    <AppLayout
      topBar={
        <QueryTopBar
          ioProfiles={postgresProfiles}
          ioProfile={ioProfile}
          defaultReadProfileId={settings?.default_read_profile}
          catalogs={catalogs}
          catalogPath={catalogPath}
          defaultCatalogFilename={settings?.default_catalog}
          onOpenCatalogPicker={() => dialogs.catalogPicker.open()}
          onOpenIoReaderPicker={() => dialogs.ioReaderPicker.open()}
          isStreaming={isStreaming || sourceProfileId !== null}
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
        isStreaming={isStreaming || sourceProfileId !== null}
        contentArea={{ className: "p-0" }}
      >
        {activeTab === "query" && (
          <QueryBuilderPanel
            profileId={sourceProfileId}
            disabled={!sourceProfileId}
            favourites={favourites}
            timeBounds={timeBounds}
            onTimeBoundsChange={handleTimeBoundsChangeWrapper}
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
        {activeTab === "stats" && <StatsPanel profileId={sourceProfileId} />}
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
        defaultFilename={settings?.default_catalog}
        onSelect={handlers.handleCatalogChange}
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
