// src/apps/query/Query.tsx
//
// Query app for querying PostgreSQL data sources to answer analytical questions
// about CAN bus history. Uses the session system so other apps can share the
// session to visualise discovered timeslices.

import { useCallback, useEffect, useMemo, useState } from "react";
import { useSettings } from "../../hooks/useSettings";
import { useIOSessionManager } from "../../hooks/useIOSessionManager";
import { useQueryStore } from "./stores/queryStore";
import { useDialogManager } from "../../hooks/useDialogManager";
import type { FrameMessage } from "../../stores/discoveryStore";
import type { PlaybackPosition } from "../../api/io";
import type { CatalogMetadata } from "../../api/catalog";
import { listCatalogs } from "../../api/catalog";
import { getFavoritesForProfile, addFavorite, type TimeRangeFavorite } from "../../utils/favorites";
import { loadCatalog } from "../../utils/catalogParser";
import AppLayout from "../../components/AppLayout";
import AppTabView, { type TabDefinition, type ProtocolBadge } from "../../components/AppTabView";
import QueryTopBar from "./views/QueryTopBar";
import QueryBuilderPanel from "./views/QueryBuilderPanel";
import QueuePanel from "./views/QueuePanel";
import ResultsPanel from "./views/ResultsPanel";
import StatsPanel from "./views/StatsPanel";
import IoReaderPickerDialog from "../../dialogs/IoReaderPickerDialog";
import ErrorDialog from "../../dialogs/ErrorDialog";
import CatalogPickerDialog from "../decoder/dialogs/CatalogPickerDialog";
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
  const setSelectedQueryId = useQueryStore((s) => s.setSelectedQueryId);
  const removeQueueItem = useQueryStore((s) => s.removeQueueItem);
  const catalogPath = useQueryStore((s) => s.catalogPath);
  const setCatalogPath = useQueryStore((s) => s.setCatalogPath);
  const setParsedCatalog = useQueryStore((s) => s.setParsedCatalog);
  const selectedFavouriteId = useQueryStore((s) => s.selectedFavouriteId);
  const setSelectedFavouriteId = useQueryStore((s) => s.setSelectedFavouriteId);

  // Catalog state
  const [catalogs, setCatalogs] = useState<CatalogMetadata[]>([]);

  // Favourites state
  const [favourites, setFavourites] = useState<TimeRangeFavorite[]>([]);

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

  // Load favourites when profile changes
  useEffect(() => {
    if (!ioProfile) {
      setFavourites([]);
      return;
    }

    const loadFavourites = async () => {
      try {
        const favs = await getFavoritesForProfile(ioProfile);
        setFavourites(favs);
      } catch (e) {
        console.error("Failed to load favourites:", e);
      }
    };
    loadFavourites();
  }, [ioProfile]);

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
    connectOnly,
    watchSingleSource,
    stopWatch,
    skipReader,
    isStreaming,
    isStopped,
    joinerCount,
    isDetached,
    handleDetach,
    handleRejoin,
    capabilities,
    session,
  } = manager;

  // Handle Connect from IoReaderPickerDialog (connect mode)
  // Creates session without streaming - queries run inside session but don't stream to other apps
  const handleConnect = useCallback(async (profileId: string) => {
    await connectOnly(profileId);
  }, [connectOnly]);

  // Profile change handler (for onSelect callback)
  const handleIoProfileChange = useCallback(
    (profileId: string | null) => {
      setIoProfile(profileId);
    },
    [setIoProfile]
  );

  // Ingest around event handler - called when user clicks a result row
  const handleIngestAroundEvent = useCallback(
    async (timestampUs: number) => {
      const { contextWindow } = useQueryStore.getState();
      const eventTimeMs = timestampUs / 1000;

      const startTime = new Date(eventTimeMs - contextWindow.beforeMs).toISOString();
      const endTime = new Date(eventTimeMs + contextWindow.afterMs).toISOString();

      if (ioProfile) {
        await watchSingleSource(ioProfile, { startTime, endTime });
      }
    },
    [ioProfile, watchSingleSource]
  );

  // Skip handler for IO picker
  const handleSkip = useCallback(async () => {
    await skipReader();
    dialogs.ioReaderPicker.close();
  }, [skipReader, dialogs.ioReaderPicker]);

  // Close error dialog
  const handleCloseError = useCallback(() => {
    setError(null);
    dialogs.error.close();
  }, [setError, dialogs.error]);

  // Handle catalog selection
  const handleCatalogChange = useCallback(
    (path: string) => {
      setCatalogPath(path);
    },
    [setCatalogPath]
  );

  // Handle favourite selection for time bounds
  const handleFavouriteSelect = useCallback(
    (id: string | null) => {
      setSelectedFavouriteId(id);
    },
    [setSelectedFavouriteId]
  );

  // Handle queue item selection
  const handleSelectQuery = useCallback(
    (id: string) => {
      setSelectedQueryId(id);
      setActiveTab("results");
    },
    [setSelectedQueryId]
  );

  // Handle queue item removal
  const handleRemoveQuery = useCallback(
    (id: string) => {
      removeQueueItem(id);
    },
    [removeQueueItem]
  );

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

  // Handle bookmark button click (from results)
  const handleBookmarkQuery = useCallback(() => {
    if (selectedQuery) {
      dialogs.addBookmark.open();
    }
  }, [selectedQuery, dialogs.addBookmark]);

  // Handle save bookmark
  const handleSaveBookmark = useCallback(
    async (name: string, startTime: string, endTime: string) => {
      if (!ioProfile) return;
      try {
        await addFavorite(name, ioProfile, startTime, endTime);
        // Reload favourites
        const favs = await getFavoritesForProfile(ioProfile);
        setFavourites(favs);
      } catch (e) {
        console.error("Failed to save bookmark:", e);
      }
    },
    [ioProfile]
  );

  // Handle ingest all results (from selected query)
  const handleIngestAllResults = useCallback(async () => {
    const timeRange = getSelectedQueryTimeRange();
    if (timeRange && ioProfile) {
      const startTime = new Date(timeRange.minTimestampUs / 1000).toISOString();
      const endTime = new Date(timeRange.maxTimestampUs / 1000).toISOString();
      await watchSingleSource(ioProfile, { startTime, endTime });
    }
  }, [ioProfile, watchSingleSource, getSelectedQueryTimeRange]);

  // Handle export (placeholder)
  const handleExportQuery = useCallback(() => {
    // TODO: Implement export functionality
    console.log("Export query results:", selectedQuery?.id);
  }, [selectedQuery]);

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
    () => (ioProfile ? [{ label: "PostgreSQL", color: "blue" as const }] : []),
    [ioProfile]
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
          isStreaming={isStreaming}
          isStopped={isStopped}
          joinerCount={joinerCount}
          isDetached={isDetached}
          supportsTimeRange={capabilities?.supports_time_range ?? false}
          onStop={stopWatch}
          onResume={session.start}
          onDetach={handleDetach}
          onRejoin={handleRejoin}
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
        isStreaming={isStreaming}
        contentArea={{ className: "p-0" }}
      >
        {activeTab === "query" && (
          <QueryBuilderPanel
            profileId={ioProfile}
            disabled={!ioProfile}
            favourites={favourites}
            selectedFavouriteId={selectedFavouriteId}
            onFavouriteSelect={handleFavouriteSelect}
          />
        )}
        {activeTab === "queue" && (
          <QueuePanel
            onSelectQuery={handleSelectQuery}
            onRemoveQuery={handleRemoveQuery}
          />
        )}
        {activeTab === "results" && (
          <ResultsPanel
            selectedQuery={selectedQuery}
            onIngestEvent={handleIngestAroundEvent}
            onIngestAll={handleIngestAllResults}
            onExport={handleExportQuery}
            onBookmark={handleBookmarkQuery}
          />
        )}
        {activeTab === "stats" && <StatsPanel profileId={ioProfile} />}
      </AppTabView>

      {/* IO Reader Picker Dialog - connect mode for database selection */}
      <IoReaderPickerDialog
        mode="connect"
        isOpen={dialogs.ioReaderPicker.isOpen}
        onClose={() => dialogs.ioReaderPicker.close()}
        ioProfiles={postgresProfiles}
        selectedId={ioProfile}
        defaultId={settings?.default_read_profile}
        onSelect={handleIoProfileChange}
        onConnect={handleConnect}
        onSkip={handleSkip}
      />

      {/* Error Dialog */}
      <ErrorDialog
        isOpen={dialogs.error.isOpen || error !== null}
        title="Query Error"
        message={error || "An error occurred"}
        onClose={handleCloseError}
      />

      {/* Catalog Picker Dialog */}
      <CatalogPickerDialog
        isOpen={dialogs.catalogPicker.isOpen}
        onClose={() => dialogs.catalogPicker.close()}
        catalogs={catalogs}
        selectedPath={catalogPath}
        defaultFilename={settings?.default_catalog}
        onSelect={handleCatalogChange}
      />

      {/* Add Bookmark Dialog */}
      <AddBookmarkDialog
        isOpen={dialogs.addBookmark.isOpen}
        frameId={0}
        frameTime={bookmarkTimeRange.startTime}
        onClose={() => dialogs.addBookmark.close()}
        onSave={handleSaveBookmark}
      />
    </AppLayout>
  );
}
