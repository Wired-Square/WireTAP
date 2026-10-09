// ui/src/apps/catalog/CatalogEditor.tsx

import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { listen } from "@tauri-apps/api/event";
import { useTranslation } from "react-i18next";
import { useSettings, getSaveFrameIdFormat } from "../../hooks/useSettings";
import { useFrameIdFormat, withFrameIdFormat } from "../../hooks/useFrameIdFormat";
import { useCatalogEditorStore } from "../../stores/catalogEditorStore";
import { useFocusStore } from "../../stores/focusStore";
import { diffCatalog, parseCatalog } from "../../api/catalog";
import { useCatalogList } from "../../hooks/useCatalogList";
import { Eye, X } from "lucide-react";
import AppLayout from "../../components/AppLayout";
import { borderDefault, bgDataView } from "../../styles/colourTokens";
import { iconSm } from "../../styles/spacing";
import { emptyStateContainer, emptyStateText, emptyStateHeading } from "../../styles/typography";
import CatalogTreePanel from "./layouts/CatalogTreePanel";
import CatalogToolbar from "./layouts/CatalogToolbar";
import SelectionHeader from "./layouts/SelectionHeader";
import { catalogToTree } from "./tree/catalogToTree";
import type { SerialEncoding, TomlNode } from "./types";
import type { Catalog } from "../../types/catalogModel";
import { findNodeByPath } from "./tree/treeUtils";
import { formatFrameId } from "./utils";
import { createRenderTreeNode } from "./tree/renderTreeNode";
import { buildFrameGroups, applyProtocolFilter } from "./tree/frameGroups";
import EditorViewRouter from "./views/EditorViewRouter";
import TextModeView from "./views/TextModeView";
import DiffView from "./views/DiffView";
import EmptySelectionView from "./views/EmptySelectionView";
import FrameEditView from "./views/FrameEditView";
import { frameDefaultInterval, isFrameFieldsValid } from "./views/frameEditUtils";
import { CATALOG_SEARCH_INPUT_ID } from "./components/FindBar";
import TextFindBar from "./components/TextFindBar";
import CatalogDialogs from "./components/CatalogDialogs";
import CatalogPickerDialog from "../../dialogs/catalog-picker";
import { useCatalogShareDialogs } from "./components/CatalogShareDialogs";
import { useCatalogShareStore } from "../../stores/catalogShareStore";
import { hasRemoteChanges, needsDecision } from "../../utils/catalogSync";
import { sourcesFor } from "../../hooks/useCatalogSources";
import { useCatalogForms, useCatalogHandlers } from "./hooks";
import { openCatalogWithMigration } from "./io";
import { IconButton } from "../../components/Button";
import { Tab, TabDot, Tabs } from "../../components/Tabs";
import { Alert } from "../../components/Alert";
function CatalogEditorInner() {
  const { t } = useTranslation("catalog");
  // Zustand store selectors
  const catalogPath = useCatalogEditorStore((s) => s.file.path);
  const catalogContent = useCatalogEditorStore((s) => s.content.toml);
  const originalContent = useCatalogEditorStore((s) => s.content.lastSavedToml);
  const reloadVersion = useCatalogEditorStore((s) => s.content.reloadVersion);
  const setToml = useCatalogEditorStore((s) => s.setToml);
  const storedDiff = useCatalogEditorStore((s) => s.content.diff);
  const setDiff = useCatalogEditorStore((s) => s.setDiff);
  const computeHasUnsavedChanges = useCatalogEditorStore((s) => s.hasUnsavedChanges);
  const editMode = useCatalogEditorStore((s) => s.mode);
  const setMode = useCatalogEditorStore((s) => s.setMode);
  const validationState = useCatalogEditorStore((s) => s.validation.isValid);
  const parsedTree = useCatalogEditorStore((s) => s.tree.nodes);
  const expandedNodes = useCatalogEditorStore((s) => s.tree.expandedIds);
  const selectedPath = useCatalogEditorStore((s) => s.tree.selectedPath);
  const setTreeData = useCatalogEditorStore((s) => s.setTreeData);
  const setSelectedPath = useCatalogEditorStore((s) => s.setSelectedPath);
  const toggleExpanded = useCatalogEditorStore((s) => s.toggleExpanded);
  const expandAll = useCatalogEditorStore((s) => s.expandAll);
  const collapseAll = useCatalogEditorStore((s) => s.resetExpanded);
  const catalog = useCatalogEditorStore((s) => s.tree.catalog);
  const availablePeers = useCatalogEditorStore((s) => s.ui.availablePeers);
  const setAvailablePeers = useCatalogEditorStore((s) => s.setAvailablePeers);
  const availableSlaves = useCatalogEditorStore((s) => s.ui.availableSlaves);
  const setAvailableSlaves = useCatalogEditorStore((s) => s.setAvailableSlaves);
  const viewMode = useCatalogEditorStore((s) => s.ui.viewMode);
  const setViewMode = useCatalogEditorStore((s) => s.setViewMode);
  const selectedProtocol = useCatalogEditorStore((s) => s.ui.selectedProtocol);
  const setSelectedProtocol = useCatalogEditorStore((s) => s.setSelectedProtocol);
  const openTextFind = useCatalogEditorStore((s) => s.openTextFind);
  const openSuccess = useCatalogEditorStore((s) => s.openSuccess);
  const openSuccessMigrated = useCatalogEditorStore((s) => s.openSuccessMigrated);
  const openSuccessRemote = useCatalogEditorStore((s) => s.openSuccessRemote);
  const banner = useCatalogEditorStore((s) => s.status.banner);
  const dismissBanner = useCatalogEditorStore((s) => s.dismissBanner);
  const openDialog = useCatalogEditorStore((s) => s.openDialog);
  const decoderDir = useCatalogEditorStore((s) => s.file.decoderDir);
  const treeScrollTop = useCatalogEditorStore((s) => s.ui.treeScrollTop);
  const setTreeScrollTop = useCatalogEditorStore((s) => s.setTreeScrollTop);

  // Track if this panel is focused (for scroll position restoration)
  const isFocused = useFocusStore((s) => s.focusedPanelId === "catalog-editor");

  // Ref for text mode textarea
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Scroll preservation for tree panel
  const treeScrollRef = useRef<HTMLDivElement | null>(null);
  const scrollTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isRestoringScrollRef = useRef(false);
  const treeScrollTopRef = useRef(treeScrollTop);
  useEffect(() => { treeScrollTopRef.current = treeScrollTop; }, [treeScrollTop]);

  const handleTreeScroll = useCallback((scrollTop: number) => {
    if (isRestoringScrollRef.current) return;
    if (scrollTimeoutRef.current) clearTimeout(scrollTimeoutRef.current);
    scrollTimeoutRef.current = setTimeout(() => {
      setTreeScrollTop(scrollTop);
    }, 100);
  }, [setTreeScrollTop]);

  // Restore scroll position when panel regains focus
  useEffect(() => {
    if (isFocused && treeScrollRef.current) {
      const saved = treeScrollTopRef.current;
      if (saved > 0) {
        isRestoringScrollRef.current = true;
        treeScrollRef.current.scrollTop = saved;
        setTimeout(() => { isRestoringScrollRef.current = false; }, 50);
      }
    }
  }, [isFocused]);

  // Catalog picker state — backend-owned list, pushed live.
  const catalogs = useCatalogList();
  const [showCatalogPicker, setShowCatalogPicker] = useState(false);
  // Text-mode sub-view: raw editor vs read-only diff against last save.
  const [textView, setTextView] = useState<"edit" | "diff">("edit");

  // Load settings
  const { settings } = useSettings();
  const { effective: displayFrameIdFormat } = useFrameIdFormat();
  const saveFrameIdFormat = getSaveFrameIdFormat(settings);

  // Form state management
  const forms = useCatalogForms();

  // Handler functions - using object-based API
  const handlers = useCatalogHandlers({
    // Settings
    settings,
    saveFrameIdFormat,

    // Signal editing state
    signalFields: forms.signalFields,
    currentIdForSignal: forms.currentIdForSignal,
    currentSignalPath: forms.currentSignalPath,
    editingSignalIndex: forms.editingSignalIndex,
    setEditingSignal: forms.setEditingSignal,
    setSignalFields: forms.setSignalFields,
    setEditingSignalIndex: forms.setEditingSignalIndex,
    setCurrentIdForSignal: forms.setCurrentIdForSignal,
    setCurrentSignalPath: forms.setCurrentSignalPath,

    // Mux editing state
    muxFields: forms.muxFields,
    currentMuxPath: forms.currentMuxPath,
    isEditingExistingMux: forms.isEditingExistingMux,
    setEditingMux: forms.setEditingMux,
    setMuxFields: forms.setMuxFields,
    setCurrentMuxPath: forms.setCurrentMuxPath,
    setIsAddingNestedMux: forms.setIsAddingNestedMux,
    setIsEditingExistingMux: forms.setIsEditingExistingMux,

    // Generic frame editing
    frameFields: forms.frameFields,
    editingFrameOriginalKey: forms.editingFrameOriginalKey,
    setEditingFrame: forms.setEditingFrame,
    setFrameFields: forms.setFrameFields,
    setEditingFrameOriginalKey: forms.setEditingFrameOriginalKey,
  });

  const catalogDefaults = useMemo(() => ({
    interval: frameDefaultInterval(catalog, forms.frameFields.protocol),
    serialEncoding: catalog?.serial?.encoding as SerialEncoding | undefined,
  }), [catalog, forms.frameFields.protocol]);

  // Computed values — the store owns the dirty logic (prefer the Rust diff, fall
  // back to a string compare); recompute when its inputs change.
  const hasUnsavedChanges = useMemo(
    () => computeHasUnsavedChanges(),
    [computeHasUnsavedChanges, storedDiff, catalogContent, originalContent],
  );

  // Recompute the diff/dirty state in Rust whenever the buffer or baseline change.
  // Equal buffers short-circuit (no round-trip); edits debounce to coalesce typing.
  useEffect(() => {
    if (catalogContent === originalContent) {
      setDiff({ dirty: false, lines: [] });
      return;
    }
    const handle = setTimeout(() => {
      diffCatalog(catalogContent, originalContent)
        .then(setDiff)
        .catch((e) => console.error("Failed to compute catalog diff:", e));
    }, 250);
    return () => clearTimeout(handle);
  }, [catalogContent, originalContent, setDiff]);

  const selectedNode = useMemo(() => {
    if (!selectedPath) return null;
    return findNodeByPath(parsedTree, selectedPath);
  }, [parsedTree, selectedPath]);

  const formatFrameIdForDisplay = useMemo(
    () => (id: string) => formatFrameId(id, displayFrameIdFormat),
    [displayFrameIdFormat]
  );

  // Priority: single configured protocol > settings default > "can"
  const handleAddFrameWithDefaults = useCallback(() => {
    const configuredProtocols = (["can", "serial", "modbus"] as const).filter((p) => catalog?.[p]);

    // If exactly one protocol is configured, use it
    if (configuredProtocols.length === 1) {
      handlers.handleAddFrame(configuredProtocols[0]);
      return;
    }

    // Otherwise fall back to settings default or "can"
    const protocol = settings?.default_frame_type || "can";
    handlers.handleAddFrame(protocol);
  }, [catalog, settings?.default_frame_type, handlers]);

  // Load default catalog on mount when settings are available
  useEffect(() => {
    if (settings) {
      handlers.loadDefaultCatalog();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings]);

  // Handler for opening catalog picker. The list is kept live by useCatalogList.
  const handleOpenCatalogPicker = useCallback(() => {
    setShowCatalogPicker(true);
  }, []);

  // Handler for selecting a catalog from the picker. Applies any schema
  // migration: the migrated text loads as the working buffer with the on-disk
  // original as the diff baseline, so the upgrade shows as a saveable diff.
  const handleSelectCatalog = useCallback(async (path: string) => {
    try {
      const { original, migration } = await openCatalogWithMigration(path);
      if (migration.changed) {
        openSuccessMigrated(path, original, migration.toml, migration.summary);
      } else {
        openSuccess(path, original);
      }
    } catch (error) {
      console.error("Failed to open catalog:", error);
    }
  }, [openSuccess, openSuccessMigrated]);

  // An import from the picker arrives as a normal selection, so it opens through
  // the migration-aware path above like any other catalogue.
  const shareDialogs = useCatalogShareDialogs({ decoderDir });

  // Every repository holding the open catalogue that has something to review — all of
  // them, because a decoder tracked against two can have an update waiting in each.
  const trackedSources = useCatalogShareStore((s) => s.tracked);
  const updatableSources = useMemo(
    () =>
      sourcesFor(trackedSources, catalogPath?.split(/[/\\]/).pop())
        // The same predicates the settings row's menu uses, over the same
        // backend-derived status — open-coding the states here is how the two drift
        // apart.
        .filter((t) => hasRemoteChanges(t.syncStatus))
        // Decisions before clean fast-forwards, then alphabetical, so the menu order
        // does not shuffle with whatever the registry happened to return.
        .sort(
          (a, b) =>
            Number(needsDecision(b.syncStatus)) - Number(needsDecision(a.syncStatus)) ||
            a.repoLabel.localeCompare(b.repoLabel),
        ),
    [catalogPath, trackedSources],
  );

  // An update handed over from another panel (Settings, typically) lands here as a
  // reviewable, saveable diff — the same buffer-vs-baseline shape a schema migration
  // uses — so nothing is written behind the user's back.
  const pendingRemoteUpdate = useCatalogEditorStore((s) => s.pendingRemoteUpdate);
  const setPendingRemoteUpdate = useCatalogEditorStore((s) => s.setPendingRemoteUpdate);
  useEffect(() => {
    if (!pendingRemoteUpdate) return;
    const { path, localToml, remoteToml, source } = pendingRemoteUpdate;
    setPendingRemoteUpdate(null);
    openSuccessRemote(path, localToml, remoteToml, source);
    setMode("text");
    setTextView("diff");
  }, [pendingRemoteUpdate, setPendingRemoteUpdate, openSuccessRemote, setMode, setTextView]);

  // Parse the catalogue (in Rust, the canonical parser) and build the editor
  // tree from the resolved model. Async + debounced + cancellable so rapid
  // edits don't race; mirrors the diff effect's pattern.
  useEffect(() => {
    if (editMode !== "ui") return;

    const clear = () => {
      setTreeData({ nodes: [], catalog: null });
      setSelectedPath(null);
      setAvailablePeers([]);
      setAvailableSlaves([]);
    };

    if (!catalogContent) {
      clear();
      return;
    }

    let cancelled = false;
    const applyParsed = (parsed: Catalog) => {
      const nodes = catalogToTree(parsed);
      setTreeData({ nodes, catalog: parsed });
      const declared = parsed.nodes ?? [];
      setAvailablePeers(declared.map((n) => n.name));
      setAvailableSlaves(declared.flatMap((n) => (n.deviceAddress == null ? [] : [{ name: n.name, address: n.deviceAddress }])));
      if (selectedPath && !findNodeByPath(nodes, selectedPath)) {
        setSelectedPath(null);
      }
    };

    const handle = setTimeout(() => {
      parseCatalog(catalogContent)
        .then((cat) => {
          if (!cancelled) applyParsed(cat);
        })
        .catch((e) => {
          if (cancelled) return;
          console.warn("Failed to parse catalogue:", e);
          clear();
        });
    }, 150);

    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
    // Include reloadVersion to trigger re-parse on reload (even if content unchanged)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [catalogContent, reloadVersion, editMode]);

  // Listen for Find menu event from native Edit menu
  useEffect(() => {
    const unlisten = listen("menu-find", () => {
      if (editMode === "text") {
        openTextFind();
      } else {
        // The sidebar search is always visible in UI mode — just focus it.
        const input = document.getElementById(CATALOG_SEARCH_INPUT_ID) as HTMLInputElement | null;
        input?.focus();
        input?.select();
      }
    });

    return () => {
      unlisten.then((fn) => fn());
    };
  }, [editMode, openTextFind]);

  // Tree navigation handlers
  const handleNodeClick = (node: TomlNode) => {
    setSelectedPath(node.path);
  };

  const handleToggleExpand = (node: TomlNode) => {
    const nodePath = node.path.join(".");
    toggleExpanded(nodePath);
  };

  const renderTreeNode = useMemo(() => {
    return createRenderTreeNode({
      expandedNodes,
      selectedNode,
      onNodeClick: handleNodeClick,
      onToggleExpand: handleToggleExpand,
      displayFrameIdFormat,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expandedNodes, selectedNode, displayFrameIdFormat]);

  // The protocol badges narrow the displayed tree to one protocol's frames.
  const displayTree = useMemo(
    () => applyProtocolFilter(parsedTree, selectedProtocol),
    [parsedTree, selectedProtocol]
  );

  const frameGroups = useMemo(
    () => (viewMode === "tree" ? [] : buildFrameGroups(displayTree, viewMode)),
    [displayTree, viewMode]
  );

  return (
    <AppLayout
      topBar={
        <CatalogToolbar
          editMode={editMode}
          catalogPath={catalogPath}
          hasUnsavedChanges={hasUnsavedChanges}
          validationState={validationState}
          catalogs={catalogs}
          onOpenPicker={handleOpenCatalogPicker}
          onSave={handlers.handleSave}
          onReload={handlers.handleReload}
          onExport={() => forms.setShowExportDialog(true)}
          onValidate={handlers.handleValidate}
          onToggleMode={() => setMode(editMode === "ui" ? "text" : "ui")}
          onEditConfig={() => openDialog("config")}
          updatableSources={updatableSources}
          onReviewUpdate={shareDialogs.openUpdate}
          onPublish={() =>
            // The saved file is the unit of publishing, not the editor buffer.
            catalogPath && shareDialogs.openPublish(catalogPath.split(/[/\\]/).pop()!)
          }
        />
      }
    >
      {/* Bubble container */}
      <div className={`flex-1 flex flex-col min-h-0 rounded-lg border ${borderDefault} overflow-hidden`}>
        <div className={`flex-1 flex min-h-0 overflow-hidden ${bgDataView}`}>
        {/* Tree View Panel - Only show in UI mode */}
        {editMode === "ui" && (
          <CatalogTreePanel
            visible={editMode === "ui"}
            catalogPath={catalogPath}
            parsedTree={displayTree}
            renderTreeNode={renderTreeNode}
            scrollRef={treeScrollRef}
            onScroll={handleTreeScroll}
            viewMode={viewMode}
            setViewMode={setViewMode}
            frameGroups={frameGroups}
            selectedProtocol={selectedProtocol}
            setSelectedProtocol={setSelectedProtocol}
            catalog={catalog}
            onAddNode={handlers.handleAddNode}
            onAddFrame={handleAddFrameWithDefaults}
            onExpandAll={expandAll}
            onCollapseAll={collapseAll}
          />
        )}

        <main className="flex-1 flex flex-col min-h-0 overflow-hidden">
          {/* One banner for both cases where the buffer came from somewhere other
              than the file on disk — a schema upgrade, or an upstream update
              pulled in for review. Either way it is an unsaved, diffable change. */}
          {banner && (
            <Alert
              tone="warning"
              size="sm"
              banner
              action={
                <IconButton onClick={dismissBanner} aria-label={t("common.dismiss", "Dismiss")} size="sm">
                  <X className={iconSm} />
                </IconButton>
              }
            >
              <p className="font-medium">
                {banner.kind === "remoteUpdate"
                  ? t("editor.remoteUpdateBanner", { source: banner.source })
                  : t("editor.migrationBanner")}{" "}
                <button
                  type="button"
                  onClick={() => {
                    setMode("text");
                    setTextView("diff");
                  }}
                  className="underline font-semibold hover:no-underline"
                >
                  {t("editor.textViewDiff", "Diff")}
                </button>
                .
              </p>
              {banner.kind === "migration" && banner.summary.length > 0 && (
                <ul className="mt-1 list-disc list-inside">
                  {banner.summary.map((line, i) => (
                    <li key={i}>{line}</li>
                  ))}
                </ul>
              )}
            </Alert>
          )}
          {editMode === "text" ? (
            <>
              {catalogPath && (
                <div className="flex items-center px-3 py-1.5 border-b border-default bg-surface">
                  <Tabs variant="segmented">
                    <Tab selected={textView === "edit"} onClick={() => setTextView("edit")}>
                      {t("editor.textViewEdit", "Edit")}
                    </Tab>
                    <Tab selected={textView === "diff"} onClick={() => setTextView("diff")}>
                      {t("editor.textViewDiff", "Diff")}
                      {hasUnsavedChanges && <TabDot tone="warning" />}
                    </Tab>
                  </Tabs>
                </div>
              )}
              {textView === "diff" && catalogPath ? (
                <DiffView lines={storedDiff?.lines ?? []} />
              ) : (
                <>
                  {catalogPath && <TextFindBar textareaRef={textareaRef} />}
                  <TextModeView
                    ref={textareaRef}
                    toml={catalogContent}
                    onChangeToml={setToml}
                    placeholder={t("editor.openCatalogPlaceholder")}
                    isDisabled={!catalogPath}
                  />
                </>
              )}
            </>
          ) : (
            <div className="flex-1 p-6 overflow-y-auto overflow-x-hidden bg-primary">
              {!catalogPath ? (
                <div className={emptyStateContainer}>
                  <div className={emptyStateText}>
                    <Eye className="w-12 h-12 mx-auto mb-4 opacity-50" />
                    <p className={emptyStateHeading}>{t("editor.openCatalogUiPrompt")}</p>
                  </div>
                </div>
              ) : forms.editingFrame && !selectedNode ? (
                <FrameEditView
                  title={forms.editingFrameOriginalKey ? t("editor.editFrameTitle") : t("editor.addFrameTitle")}
                  subtitle={
                    forms.editingFrameOriginalKey
                      ? t("editor.editFrameDescription")
                      : t("editor.addFrameDescription")
                  }
                  fields={forms.frameFields}
                  setFields={forms.setFrameFields}
                  availablePeers={availablePeers}
                  availableSlaves={availableSlaves}
                  allowProtocolChange={!forms.editingFrameOriginalKey}
                  defaults={catalogDefaults}
                  onCancel={handlers.handleCancelFrameEdit}
                  onSave={handlers.handleSaveFrame}
                  primaryActionLabel={forms.editingFrameOriginalKey ? t("editor.saveChanges") : t("editor.addFrameButton")}
                  disableSave={!isFrameFieldsValid(forms.frameFields)}
                />
              ) : !selectedNode ? (
                <EmptySelectionView />
              ) : (
                <div className="max-w-4xl">
                  <SelectionHeader
                    selectedNode={selectedNode}
                    formatFrameId={formatFrameIdForDisplay}
                    onEdit={selectedNode.type === "can-frame" ? () => handlers.handleEditFrame(selectedNode) : undefined}
                    onDelete={selectedNode.type === "can-frame" ? () => handlers.handleDeleteId(selectedNode.key) : undefined}
                  />

                  <EditorViewRouter
                    selectedNode={selectedNode}
                    genericChildrenProps={{
                      selectedNode,
                      onSelectNode: (node) => setSelectedPath(node.path),
                      onRequestDelete: handlers.handleRequestDeleteGeneric,
                    }}
                    canFrameProps={{
                      selectedNode,
                      displayFrameIdFormat,
                      editingSignal: forms.editingSignal,
                      onAddSignal: handlers.handleAddSignal,
                      onEditSignal: handlers.handleEditSignal,
                      onRequestDeleteSignal: handlers.requestDeleteSignal,
                      onAddMux: handlers.handleAddMux,
                      onEditMux: handlers.handleEditMux,
                      onDeleteMux: handlers.handleDeleteMux,
                      onAddCase: handlers.handleAddCase,
                      onSelectNode: (node: any) => setSelectedPath(node.path),
                    }}
                    metaProps={{
                      catalog,
                      onEditMeta: () => openDialog("config"),
                    }}
                    muxProps={{
                      selectedNode,
                      onAddCase: handlers.handleAddCase,
                      onEditMux: handlers.handleEditMux,
                      onDeleteMux: handlers.handleDeleteMux,
                      onSelectNode: (node) => setSelectedPath(node.path),
                    }}
                    muxCaseProps={{
                      selectedNode,
                      onAddSignal: handlers.handleAddSignal,
                      onAddNestedMux: handlers.handleAddMux,
                      onEditCase: handlers.handleEditCase,
                      onDeleteCase: handlers.handleDeleteCase,
                      onRequestDeleteSignal: (idKey, signalIndex, parentPath, signalName) =>
                        handlers.requestDeleteSignal(idKey, signalIndex, parentPath, signalName),
                      onSelectNode: (node) => setSelectedPath(node.path),
                    }}
                    signalProps={{
                      selectedNode,
                      onEditSignal: handlers.handleEditSignal,
                      onRequestDeleteSignal: handlers.requestDeleteSignal,
                    }}
                    checksumProps={{
                      onEditChecksum: handlers.handleEditChecksum,
                      onRequestDeleteChecksum: handlers.requestDeleteChecksum,
                    }}
                    nodeProps={{
                      selectedNode,
                      displayFrameIdFormat,
                      onSelectPath: (path) => setSelectedPath(path),
                      onAddCanFrameForNode: (transmitter) => handlers.handleAddFrame("can", { transmitter }),
                      onAddRegisterForSlave: (nodeAddress) => handlers.handleAddFrame("modbus", { nodeAddress }),
                      onEditNode: handlers.handleEditNode,
                      onDeleteNode: handlers.handleRequestDeleteNode,
                      onRequestDeleteFrame: handlers.handleDeleteId,
                      onRequestDeleteRegister: (key) => handlers.handleDeleteFrame("modbus", key),
                      onRequestDeleteSignal: (idKey, index, parentPath, signalName) =>
                        handlers.requestDeleteSignal(idKey, index, parentPath, signalName),
                    }}
                    modbusFrameProps={{
                      onEditFrame: handlers.handleEditFrame,
                      onDeleteFrame: (key) => handlers.handleDeleteFrame("modbus", key),
                    }}
                    serialFrameProps={{
                      editingSignal: forms.editingSignal,
                      onEditFrame: handlers.handleEditFrame,
                      onDeleteFrame: (key) => handlers.handleDeleteFrame("serial", key),
                      onEditSerialConfig: () => openDialog("config"),
                      onAddSignal: (idKey) => handlers.handleAddSignal(idKey, ["frame", "serial", idKey]),
                      onEditSignal: handlers.handleEditSignal,
                      onRequestDeleteSignal: handlers.requestDeleteSignal,
                      onAddMux: handlers.handleAddMux,
                    }}
                    fallback={<></>}
                  />
                </div>
              )}
            </div>
          )}

        </main>
        </div>
      </div>

      <CatalogDialogs
        editingSignal={forms.editingSignal}
        currentIdForSignal={forms.currentIdForSignal}
        currentSignalPath={forms.currentSignalPath}
        selectedNode={selectedNode}
        catalogContent={catalogContent}
        signalFields={forms.signalFields}
        setSignalFields={forms.setSignalFields}
        editingSignalIndex={forms.editingSignalIndex}
        setEditingSignal={forms.setEditingSignal}
        editingMux={forms.editingMux}
        currentMuxPath={forms.currentMuxPath}
        isAddingNestedMux={forms.isAddingNestedMux}
        isEditingExistingMux={forms.isEditingExistingMux}
        muxFields={forms.muxFields}
        setMuxFields={forms.setMuxFields}
        setEditingMux={forms.setEditingMux}
        showExportDialog={forms.showExportDialog}
        setShowExportDialog={forms.setShowExportDialog}
        catalogPath={catalogPath}
        handlers={handlers}
      />

      <CatalogPickerDialog
        isOpen={showCatalogPicker}
        onClose={() => setShowCatalogPicker(false)}
        selectedPath={catalogPath}
        onSelect={handleSelectCatalog}
        onNewCatalog={handlers.handleNewCatalog}
      />

      {shareDialogs.element}
    </AppLayout>
  );
}

export default withFrameIdFormat(CatalogEditorInner);
