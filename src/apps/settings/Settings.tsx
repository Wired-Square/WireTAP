// ui/src/apps/settings/Settings.tsx

import { useEffect, useState } from 'react';
import { pickDirectory } from '../../api/dialogs';
import AppLayout from "../../components/AppLayout";
import AppTopBar from "../../components/AppTopBar";
import AppSideBar, { type SideBarItem } from "../../components/AppSideBar";
import { Cog, MapPin, Cable, BookOpen, Monitor, Bookmark, Star, LayoutGrid, Shield } from "lucide-react";
import { bgDataView, borderDataView } from "../../styles/colourTokens";
import LocationsView from './views/LocationsView';
import DisplayView from './views/DisplayView';
import CatalogsView from './views/CatalogsView';
import DataIOView from './views/DataIOView';
import GeneralView from './views/GeneralView';
import BookmarksView from './views/BookmarksView';
import SelectionSetsView from './views/SelectionSetsView';
import GraphLayoutsView from './views/GraphLayoutsView';
import PrivacyView from './views/PrivacyView';
import IOProfileDialog from './dialogs/IOProfileDialog';
import EditCatalogDialog from './dialogs/EditCatalogDialog';
import ConfirmDeleteDialog from '../../dialogs/ConfirmDeleteDialog';
import DuplicateCatalogDialog from './dialogs/DuplicateCatalogDialog';
import EditBookmarkDialog from './dialogs/EditBookmarkDialog';
import EditSelectionSetDialog from './dialogs/EditSelectionSetDialog';
import EditGraphLayoutDialog from './dialogs/EditGraphLayoutDialog';
import CreateBookmarkDialog from './dialogs/CreateBookmarkDialog';
import { useSettingsStore, type SettingsSection } from './stores/settingsStore';
import { useSettingsForms } from './hooks/useSettingsForms';
import { useSettingsHandlers } from './hooks/useSettingsHandlers';
import { getTimeRangeCapableProfiles } from '../../utils/profileFilters';
import { isIOS } from '../../utils/platform';
import { onStoreChanged } from '../../api/store';

export default function Settings() {
  // Form state for dialogs
  const forms = useSettingsForms();

  // Store state
  const currentSection = useSettingsStore((s) => s.ui.currentSection);
  const setSection = useSettingsStore((s) => s.setSection);
  const loadSettings = useSettingsStore((s) => s.loadSettings);
  const loadBookmarks = useSettingsStore((s) => s.loadBookmarks);
  const loadSelectionSets = useSettingsStore((s) => s.loadSelectionSets);
  const loadGraphLayouts = useSettingsStore((s) => s.loadGraphLayouts);

  // Locations
  const decoderDir = useSettingsStore((s) => s.locations.decoderDir);
  const dumpDir = useSettingsStore((s) => s.locations.dumpDir);
  const reportDir = useSettingsStore((s) => s.locations.reportDir);
  const decoderValidation = useSettingsStore((s) => s.locations.decoderValidation);
  const dumpValidation = useSettingsStore((s) => s.locations.dumpValidation);
  const reportValidation = useSettingsStore((s) => s.locations.reportValidation);
  const setDecoderDir = useSettingsStore((s) => s.setDecoderDir);
  const setDumpDir = useSettingsStore((s) => s.setDumpDir);
  const setReportDir = useSettingsStore((s) => s.setReportDir);

  // Display
  const saveFrameIdFormat = useSettingsStore((s) => s.display.saveFrameIdFormat);
  const setSaveFrameIdFormat = useSettingsStore((s) => s.setSaveFrameIdFormat);
  const displayFrameIdFormat = useSettingsStore((s) => s.display.frameIdFormat);
  const setDisplayFrameIdFormat = useSettingsStore((s) => s.setDisplayFrameIdFormat);
  const displayTimeFormat = useSettingsStore((s) => s.display.timeFormat);
  const setDisplayTimeFormat = useSettingsStore((s) => s.setDisplayTimeFormat);
  const timezone = useSettingsStore((s) => s.display.timezone);
  const setTimezone = useSettingsStore((s) => s.setTimezone);
  const signalColours = useSettingsStore((s) => s.display.signalColours);
  const setSignalColour = useSettingsStore((s) => s.setSignalColour);
  const resetSignalColour = useSettingsStore((s) => s.resetSignalColour);
  const binaryOneColour = useSettingsStore((s) => s.display.binaryOneColour);
  const setBinaryOneColour = useSettingsStore((s) => s.setBinaryOneColour);
  const resetBinaryOneColour = useSettingsStore((s) => s.resetBinaryOneColour);
  const binaryZeroColour = useSettingsStore((s) => s.display.binaryZeroColour);
  const setBinaryZeroColour = useSettingsStore((s) => s.setBinaryZeroColour);
  const resetBinaryZeroColour = useSettingsStore((s) => s.resetBinaryZeroColour);
  const binaryUnusedColour = useSettingsStore((s) => s.display.binaryUnusedColour);
  const setBinaryUnusedColour = useSettingsStore((s) => s.setBinaryUnusedColour);
  const resetBinaryUnusedColour = useSettingsStore((s) => s.resetBinaryUnusedColour);

  // Theme
  const themeMode = useSettingsStore((s) => s.display.themeMode);
  const setThemeMode = useSettingsStore((s) => s.setThemeMode);
  const themeColours = useSettingsStore((s) => s.display.themeColours);
  const setThemeColour = useSettingsStore((s) => s.setThemeColour);
  const resetThemeColours = useSettingsStore((s) => s.resetThemeColours);

  // General
  const discoveryHistoryBuffer = useSettingsStore((s) => s.general.discoveryHistoryBuffer);
  const setDiscoveryHistoryBuffer = useSettingsStore((s) => s.setDiscoveryHistoryBuffer);
  const defaultFrameType = useSettingsStore((s) => s.general.defaultFrameType);
  const setDefaultFrameType = useSettingsStore((s) => s.setDefaultFrameType);
  const queryResultLimit = useSettingsStore((s) => s.general.queryResultLimit);
  const setQueryResultLimit = useSettingsStore((s) => s.setQueryResultLimit);
  const graphBufferSize = useSettingsStore((s) => s.general.graphBufferSize);
  const setGraphBufferSize = useSettingsStore((s) => s.setGraphBufferSize);
  const preventIdleSleep = useSettingsStore((s) => s.general.preventIdleSleep);
  const setPreventIdleSleep = useSettingsStore((s) => s.setPreventIdleSleep);
  const keepDisplayAwake = useSettingsStore((s) => s.general.keepDisplayAwake);
  const setKeepDisplayAwake = useSettingsStore((s) => s.setKeepDisplayAwake);
  const enableFileLogging = useSettingsStore((s) => s.general.enableFileLogging);
  const setEnableFileLogging = useSettingsStore((s) => s.setEnableFileLogging);

  // Privacy
  const telemetryEnabled = useSettingsStore((s) => s.general.telemetryEnabled);
  const setTelemetryEnabled = useSettingsStore((s) => s.setTelemetryEnabled);

  // IO Profiles
  const ioProfiles = useSettingsStore((s) => s.ioProfiles.profiles);
  const defaultReadProfile = useSettingsStore((s) => s.ioProfiles.defaultReadProfile);
  const timeRangeCapableProfiles = getTimeRangeCapableProfiles(ioProfiles);

  // Catalogs
  const catalogs = useSettingsStore((s) => s.catalogs.list);
  const defaultCatalog = useSettingsStore((s) => s.catalogs.defaultCatalog);

  // Bookmarks
  const bookmarks = useSettingsStore((s) => s.bookmarks);

  // Selection sets
  const selectionSets = useSettingsStore((s) => s.selectionSets);

  // Graph layouts
  const graphLayouts = useSettingsStore((s) => s.graphLayouts);

  // Dialog state
  const dialogs = useSettingsStore((s) => s.ui.dialogs);
  const dialogPayload = useSettingsStore((s) => s.ui.dialogPayload);

  // Handlers
  const handlers = useSettingsHandlers({
    catalogName: forms.catalogName,
    catalogFilename: forms.catalogFilename,
    setCatalogName: forms.setCatalogName,
    setCatalogFilename: forms.setCatalogFilename,
    resetCatalogForm: forms.resetCatalogForm,
    initDuplicateCatalogForm: forms.initDuplicateCatalogForm,
    initEditCatalogForm: forms.initEditCatalogForm,
    bookmarkName: forms.bookmarkName,
    bookmarkTimeBounds: forms.bookmarkTimeBounds,
    resetBookmarkForm: forms.resetBookmarkForm,
    initEditBookmarkForm: forms.initEditBookmarkForm,
    newBookmarkProfileId: forms.newBookmarkProfileId,
    newBookmarkName: forms.newBookmarkName,
    newBookmarkTimeBounds: forms.newBookmarkTimeBounds,
    resetNewBookmarkForm: forms.resetNewBookmarkForm,
    initNewBookmarkForm: forms.initNewBookmarkForm,
    timeRangeCapableProfiles,
    selectionSetName: forms.selectionSetName,
    resetSelectionSetForm: forms.resetSelectionSetForm,
    initEditSelectionSetForm: forms.initEditSelectionSetForm,
    graphLayoutName: forms.graphLayoutName,
    resetGraphLayoutForm: forms.resetGraphLayoutForm,
    initEditGraphLayoutForm: forms.initEditGraphLayoutForm,
  });

  // Sidebar collapsed state
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  // Platform detection for iOS-specific UI hiding
  const [isIOSPlatform, setIsIOSPlatform] = useState(false);

  // Load data on mount and detect platform
  useEffect(() => {
    loadSettings();
    loadBookmarks();
    loadSelectionSets();
    loadGraphLayouts();
    isIOS().then(setIsIOSPlatform);
  }, [loadSettings, loadBookmarks, loadSelectionSets, loadGraphLayouts]);

  // Reload collections when they change from other panels
  useEffect(() => {
    const promise = onStoreChanged((event) => {
      if (event.key === 'graph.layouts') loadGraphLayouts();
      if (event.key === 'favorites.timeRanges') loadBookmarks();
      if (event.key === 'selectionSets.all') loadSelectionSets();
    });
    return () => { promise.then((unlisten) => unlisten()); };
  }, [loadGraphLayouts, loadBookmarks, loadSelectionSets]);

  // Sidebar items (Storage hidden on iOS due to sandboxing restrictions)
  const sidebarItems: SideBarItem[] = [
    { id: 'general', label: 'General', icon: Cog },
    { id: 'privacy', label: 'Privacy', icon: Shield },
    // Hide Storage on iOS - custom directory paths aren't supported
    ...(!isIOSPlatform ? [{ id: 'locations' as const, label: 'Storage', icon: MapPin }] : []),
    { id: 'data-io', label: 'Data IO', icon: Cable },
    { id: 'catalogs', label: 'Catalogs', icon: BookOpen },
    { id: 'bookmarks', label: 'Bookmarks', icon: Bookmark },
    { id: 'selection-sets', label: 'Selection Sets', icon: Star },
    { id: 'graph-layouts', label: 'Graph Layouts', icon: LayoutGrid },
    { id: 'display', label: 'Display', icon: Monitor },
  ];

  // Directory picker helper
  const handlePickDirectory = async (
    currentPath: string,
    setter: (path: string) => void
  ) => {
    try {
      const selected = await pickDirectory(currentPath);
      if (selected) {
        setter(selected);
      }
    } catch (error) {
      console.error('Failed to pick directory:', error);
    }
  };

  return (
    <AppLayout
      topBar={
        <AppTopBar
          icon={Cog}
          iconColour="text-[color:var(--accent-warning)]"
        />
      }
    >
      {/* Sidebar + Content in bubble */}
      <div className={`flex-1 flex min-h-0 rounded-lg border ${borderDataView} overflow-hidden`}>
        <AppSideBar
          items={sidebarItems}
          activeItem={currentSection}
          onSelect={(id) => setSection(id as SettingsSection)}
          collapsed={sidebarCollapsed}
          onToggleCollapsed={() => setSidebarCollapsed(!sidebarCollapsed)}
        />

        {/* Content Area */}
        <main className={`flex-1 min-h-0 overflow-y-auto p-6 ${bgDataView}`}>
          {/* Locations Section (hidden on iOS) */}
          {currentSection === 'locations' && !isIOSPlatform && (
            <LocationsView
              decoderDir={decoderDir}
              dumpDir={dumpDir}
              reportDir={reportDir}
              saveFrameIdFormat={saveFrameIdFormat}
              decoderValidation={decoderValidation}
              dumpValidation={dumpValidation}
              reportValidation={reportValidation}
              onChangeDecoderDir={setDecoderDir}
              onChangeDumpDir={setDumpDir}
              onChangeReportDir={setReportDir}
              onChangeSaveFrameIdFormat={setSaveFrameIdFormat}
              onPickDecoderDir={() => handlePickDirectory(decoderDir, setDecoderDir)}
              onPickDumpDir={() => handlePickDirectory(dumpDir, setDumpDir)}
              onPickReportDir={() => handlePickDirectory(reportDir, setReportDir)}
            />
          )}

          {currentSection === 'general' && (
            <GeneralView
              discoveryHistoryBuffer={discoveryHistoryBuffer}
              onChangeDiscoveryHistoryBuffer={setDiscoveryHistoryBuffer}
              defaultFrameType={defaultFrameType}
              onChangeDefaultFrameType={setDefaultFrameType}
              queryResultLimit={queryResultLimit}
              onChangeQueryResultLimit={setQueryResultLimit}
              graphBufferSize={graphBufferSize}
              onChangeGraphBufferSize={setGraphBufferSize}
              preventIdleSleep={preventIdleSleep}
              onChangePreventIdleSleep={setPreventIdleSleep}
              keepDisplayAwake={keepDisplayAwake}
              onChangeKeepDisplayAwake={setKeepDisplayAwake}
              enableFileLogging={enableFileLogging}
              onChangeEnableFileLogging={setEnableFileLogging}
              isIOS={isIOSPlatform}
            />
          )}

          {currentSection === 'privacy' && (
            <PrivacyView
              telemetryEnabled={telemetryEnabled}
              onChangeTelemetryEnabled={setTelemetryEnabled}
            />
          )}

          {/* Data IO Section */}
          {currentSection === 'data-io' && (
            <DataIOView
              ioProfiles={ioProfiles}
              defaultReadProfile={defaultReadProfile}
              onToggleDefaultRead={handlers.toggleDefaultRead}
              onAddProfile={handlers.handleAddIOProfile}
              onEditProfile={(profile) => handlers.handleEditIOProfile(profile.id)}
              onDeleteProfile={handlers.handleDeleteIOProfile}
              onDuplicateProfile={handlers.handleDuplicateIOProfile}
            />
          )}

          {/* Catalogs Section */}
          {currentSection === 'catalogs' && (
            <CatalogsView
              catalogs={catalogs}
              decoderDir={decoderDir}
              defaultCatalog={defaultCatalog}
              onSetDefaultCatalog={handlers.handleSetDefaultCatalog}
              onDuplicateCatalog={handlers.handleDuplicateCatalog}
              onEditCatalog={handlers.handleEditCatalog}
              onDeleteCatalog={handlers.handleDeleteCatalog}
            />
          )}

          {/* Bookmarks Section */}
          {currentSection === 'bookmarks' && (
            <BookmarksView
              bookmarks={bookmarks}
              ioProfiles={ioProfiles}
              timeRangeCapableProfiles={timeRangeCapableProfiles}
              onEditBookmark={handlers.handleEditBookmark}
              onDeleteBookmark={handlers.handleDeleteBookmark}
              onNewBookmark={handlers.handleNewBookmark}
            />
          )}

          {/* Selection Sets Section */}
          {currentSection === 'selection-sets' && (
            <SelectionSetsView
              selectionSets={selectionSets}
              onEditSelectionSet={handlers.handleEditSelectionSet}
              onDeleteSelectionSet={handlers.handleDeleteSelectionSet}
            />
          )}

          {/* Graph Layouts Section */}
          {currentSection === 'graph-layouts' && (
            <GraphLayoutsView
              graphLayouts={graphLayouts}
              onEditGraphLayout={handlers.handleEditGraphLayout}
              onDeleteGraphLayout={handlers.handleDeleteGraphLayout}
            />
          )}

          {/* Display Section */}
          {currentSection === 'display' && (
            <DisplayView
              displayFrameIdFormat={displayFrameIdFormat}
              displayTimeFormat={displayTimeFormat}
              onChangeFormat={setDisplayFrameIdFormat}
              onChangeTimeFormat={setDisplayTimeFormat}
              timezone={timezone}
              onChangeTimezone={setTimezone}
              signalColours={signalColours}
              onChangeSignalColour={setSignalColour}
              onResetSignalColour={resetSignalColour}
              binaryOneColour={binaryOneColour}
              onChangeBinaryOneColour={setBinaryOneColour}
              onResetBinaryOneColour={resetBinaryOneColour}
              binaryZeroColour={binaryZeroColour}
              onChangeBinaryZeroColour={setBinaryZeroColour}
              onResetBinaryZeroColour={resetBinaryZeroColour}
              binaryUnusedColour={binaryUnusedColour}
              onChangeBinaryUnusedColour={setBinaryUnusedColour}
              onResetBinaryUnusedColour={resetBinaryUnusedColour}
              themeMode={themeMode}
              onChangeThemeMode={setThemeMode}
              themeColours={themeColours}
              onChangeThemeColour={setThemeColour}
              onResetThemeColours={resetThemeColours}
            />
          )}
        </main>
      </div>

      {/* IO Profile Dialog */}
      <IOProfileDialog
        isOpen={dialogs.ioProfile}
        editingProfileId={dialogPayload.editingProfileId}
        profileForm={dialogPayload.profileForm}
        originalProfile={
          dialogPayload.editingProfileId
            ? ioProfiles.find((p) => p.id === dialogPayload.editingProfileId) ?? null
            : null
        }
        onCancel={handlers.handleCancelProfile}
        onSave={handlers.handleSaveProfile}
        onMigratePassword={handlers.handleSaveProfile}
        onUpdateProfileField={handlers.updateProfileField}
        onUpdateConnectionField={handlers.updateConnectionField}
        onUpdateMqttFormat={handlers.updateMqttFormat}
      />

      {/* Delete IO Profile Confirmation Dialog */}
      <ConfirmDeleteDialog
        open={dialogs.deleteIOProfile}
        title="Delete IO Profile"
        message="Are you sure you want to delete"
        highlightText={dialogPayload.ioProfileToDelete?.name}
        onCancel={handlers.handleCancelDeleteIOProfile}
        onConfirm={handlers.handleConfirmDeleteIOProfile}
      />

      {/* Delete Catalog Confirmation Dialog */}
      <ConfirmDeleteDialog
        open={dialogs.deleteCatalog}
        title="Delete Catalog"
        message="Are you sure you want to delete"
        highlightText={dialogPayload.catalogToDelete?.name || dialogPayload.catalogToDelete?.filename}
        onCancel={handlers.handleCancelDelete}
        onConfirm={handlers.handleConfirmDelete}
      />

      {/* Duplicate Catalog Dialog */}
      <DuplicateCatalogDialog
        isOpen={dialogs.duplicateCatalog}
        name={forms.catalogName}
        filename={forms.catalogFilename}
        onChangeName={forms.setCatalogName}
        onChangeFilename={forms.setCatalogFilename}
        onCancel={handlers.handleCancelDuplicate}
        onDuplicate={handlers.handleConfirmDuplicate}
      />

      {/* Edit Catalog Dialog */}
      <EditCatalogDialog
        isOpen={dialogs.editCatalog}
        name={forms.catalogName}
        filename={forms.catalogFilename}
        onChangeName={forms.setCatalogName}
        onChangeFilename={forms.setCatalogFilename}
        onCancel={handlers.handleCancelEdit}
        onSave={handlers.handleConfirmEdit}
      />

      {/* Edit Bookmark Dialog */}
      <EditBookmarkDialog
        isOpen={dialogs.editBookmark}
        name={forms.bookmarkName}
        timeBounds={forms.bookmarkTimeBounds}
        onChangeName={forms.setBookmarkName}
        onChangeTimeBounds={forms.setBookmarkTimeBounds}
        onCancel={handlers.handleCancelEditBookmark}
        onSave={handlers.handleConfirmEditBookmark}
      />

      {/* Create Bookmark Dialog */}
      <CreateBookmarkDialog
        isOpen={dialogs.createBookmark}
        availableProfiles={timeRangeCapableProfiles}
        profileId={forms.newBookmarkProfileId}
        name={forms.newBookmarkName}
        timeBounds={forms.newBookmarkTimeBounds}
        onChangeProfileId={forms.setNewBookmarkProfileId}
        onChangeName={forms.setNewBookmarkName}
        onChangeTimeBounds={forms.setNewBookmarkTimeBounds}
        onCancel={handlers.handleCancelCreateBookmark}
        onCreate={handlers.handleConfirmCreateBookmark}
      />

      {/* Delete Bookmark Confirmation Dialog */}
      <ConfirmDeleteDialog
        open={dialogs.deleteBookmark}
        title="Delete Bookmark"
        message="Are you sure you want to delete"
        highlightText={dialogPayload.bookmarkToDelete?.name}
        onCancel={handlers.handleCancelDeleteBookmark}
        onConfirm={handlers.handleConfirmDeleteBookmark}
      />

      {/* Edit Selection Set Dialog */}
      <EditSelectionSetDialog
        isOpen={dialogs.editSelectionSet}
        name={forms.selectionSetName}
        onChangeName={forms.setSelectionSetName}
        onCancel={handlers.handleCancelEditSelectionSet}
        onSave={handlers.handleConfirmEditSelectionSet}
      />

      {/* Delete Selection Set Confirmation Dialog */}
      <ConfirmDeleteDialog
        open={dialogs.deleteSelectionSet}
        title="Delete Selection Set"
        message="Are you sure you want to delete"
        highlightText={dialogPayload.selectionSetToDelete?.name}
        onCancel={handlers.handleCancelDeleteSelectionSet}
        onConfirm={handlers.handleConfirmDeleteSelectionSet}
      />

      {/* Edit Graph Layout Dialog */}
      <EditGraphLayoutDialog
        isOpen={dialogs.editGraphLayout}
        name={forms.graphLayoutName}
        onChangeName={forms.setGraphLayoutName}
        onCancel={handlers.handleCancelEditGraphLayout}
        onSave={handlers.handleConfirmEditGraphLayout}
      />

      {/* Delete Graph Layout Confirmation Dialog */}
      <ConfirmDeleteDialog
        open={dialogs.deleteGraphLayout}
        title="Delete Graph Layout"
        message="Are you sure you want to delete"
        highlightText={dialogPayload.graphLayoutToDelete?.name}
        onCancel={handlers.handleCancelDeleteGraphLayout}
        onConfirm={handlers.handleConfirmDeleteGraphLayout}
      />
    </AppLayout>
  );
}
