// ui/src/apps/catalog/CatalogEditor.tsx

import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { listen } from "@tauri-apps/api/event";
import { useTranslation } from "react-i18next";
import { useSettings, getSaveFrameIdFormat } from "../../hooks/useSettings";
import { useFrameIdFormat, withFrameIdFormat } from "../../hooks/useFrameIdFormat";
import { useCatalogEditorStore } from "../../stores/catalogEditorStore";
import { useFocusStore } from "../../stores/focusStore";
import { listCatalogs, diffCatalog, parseCatalog, type CatalogMetadata } from "../../api/catalog";
import { Eye, X } from "lucide-react";
import AppLayout from "../../components/AppLayout";
import { borderDataView, bgDataView, bgWarning, textWarning, borderWarning } from "../../styles/colourTokens";
import { iconSm } from "../../styles/spacing";
import { emptyStateContainer, emptyStateText, emptyStateHeading } from "../../styles/typography";
import CatalogTreePanel from "./layouts/CatalogTreePanel";
import CatalogToolbar from "./layouts/CatalogToolbar";
import SelectionHeader from "./layouts/SelectionHeader";
import { catalogToTree } from "./tree/catalogToTree";
import type { TomlNode, ParsedCatalogTree } from "./types";
import { findNodeByPath } from "./tree/treeUtils";
import { formatFrameId } from "./utils";
import { createRenderTreeNode } from "./tree/renderTreeNode";
import { buildFrameGroups, applyProtocolFilter } from "./tree/frameGroups";
import EditorViewRouter from "./views/EditorViewRouter";
import TextModeView from "./views/TextModeView";
import DiffView from "./views/DiffView";
import EmptySelectionView from "./views/EmptySelectionView";
import CANFrameEditView from "./views/CANFrameEditView";
import FrameEditView from "./views/FrameEditView";
import { isFrameFieldsValid } from "./views/frameEditUtils";
import { CATALOG_SEARCH_INPUT_ID } from "./components/FindBar";
import TextFindBar from "./components/TextFindBar";
import CatalogDialogs from "./components/CatalogDialogs";
import CatalogPickerDialog from "./dialogs/CatalogPickerDialog";
import { useCatalogForms, useCatalogHandlers } from "./hooks";
import { openCatalogWithMigration } from "./io";

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
  const setValidation = useCatalogEditorStore((s) => s.setValidation);
  const parsedTree = useCatalogEditorStore((s) => s.tree.nodes);
  const expandedNodes = useCatalogEditorStore((s) => s.tree.expandedIds);
  const selectedPath = useCatalogEditorStore((s) => s.tree.selectedPath);
  const setTreeData = useCatalogEditorStore((s) => s.setTreeData);
  const setSelectedPath = useCatalogEditorStore((s) => s.setSelectedPath);
  const toggleExpanded = useCatalogEditorStore((s) => s.toggleExpanded);
  const expandAll = useCatalogEditorStore((s) => s.expandAll);
  const collapseAll = useCatalogEditorStore((s) => s.resetExpanded);
  const idFields = useCatalogEditorStore((s) => s.forms.canFrame);
  const setIdFields = useCatalogEditorStore((s) => s.setCanFrameForm);
  const setMetaFields = useCatalogEditorStore((s) => s.setMetaForm);
  const canDefaultEndianness = useCatalogEditorStore((s) => s.forms.canDefaultEndianness);
  const setCanDefaultEndianness = useCatalogEditorStore((s) => s.setCanDefaultEndianness);
  const canDefaultInterval = useCatalogEditorStore((s) => s.forms.canDefaultInterval);
  const setCanDefaultInterval = useCatalogEditorStore((s) => s.setCanDefaultInterval);
  const setCanDefaultExtended = useCatalogEditorStore((s) => s.setCanDefaultExtended);
  const setCanDefaultFd = useCatalogEditorStore((s) => s.setCanDefaultFd);
  const setCanFrameIdMask = useCatalogEditorStore((s) => s.setCanFrameIdMask);
  const setCanHeaderFields = useCatalogEditorStore((s) => s.setCanHeaderFields);
  const serialEncoding = useCatalogEditorStore((s) => s.forms.serialEncoding);
  const setSerialEncoding = useCatalogEditorStore((s) => s.setSerialEncoding);
  const serialByteOrder = useCatalogEditorStore((s) => s.forms.serialByteOrder);
  const setSerialByteOrder = useCatalogEditorStore((s) => s.setSerialByteOrder);
  const setSerialHeaderFields = useCatalogEditorStore((s) => s.setSerialHeaderFields);
  const setSerialHeaderLength = useCatalogEditorStore((s) => s.setSerialHeaderLength);
  const setSerialMaxFrameLength = useCatalogEditorStore((s) => s.setSerialMaxFrameLength);
  const setSerialChecksum = useCatalogEditorStore((s) => s.setSerialChecksum);
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
  const migration = useCatalogEditorStore((s) => s.status.migration);
  const dismissMigration = useCatalogEditorStore((s) => s.dismissMigration);
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

  // Catalog picker state
  const [catalogs, setCatalogs] = useState<CatalogMetadata[]>([]);
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

    // CAN frame editing (legacy)
    editingFrameId: forms.editingFrameId,
    setEditingId: forms.setEditingId,
    setEditingFrameId: forms.setEditingFrameId,

    // Generic frame editing
    frameFields: forms.frameFields,
    editingFrameOriginalKey: forms.editingFrameOriginalKey,
    setEditingFrame: forms.setEditingFrame,
    setFrameFields: forms.setFrameFields,
    setEditingFrameOriginalKey: forms.setEditingFrameOriginalKey,
  });

  // Get catalog defaults for the generic frame editor
  const modbusDeviceAddress = useCatalogEditorStore((s) => s.forms.modbusDeviceAddress);
  const modbusRegisterBase = useCatalogEditorStore((s) => s.forms.modbusRegisterBase);
  const setModbusDeviceAddress = useCatalogEditorStore((s) => s.setModbusDeviceAddress);
  const setModbusRegisterBase = useCatalogEditorStore((s) => s.setModbusRegisterBase);
  const setModbusDefaultInterval = useCatalogEditorStore((s) => s.setModbusDefaultInterval);
  const setModbusDefaultByteOrder = useCatalogEditorStore((s) => s.setModbusDefaultByteOrder);
  const setModbusDefaultWordOrder = useCatalogEditorStore((s) => s.setModbusDefaultWordOrder);
  const catalogDefaults = useMemo(() => ({
    interval: canDefaultInterval,           // From [frame.can.config], stored in forms.canDefaultInterval
    endianness: canDefaultEndianness,       // From [frame.can.config], stored in forms.canDefaultEndianness
    modbusDeviceAddress,  // From [frame.modbus.config], stored in forms.modbusDeviceAddress
    modbusRegisterBase,   // From [frame.modbus.config], stored in forms.modbusRegisterBase
    serialEncoding,       // From [frame.serial.config], stored in forms.serialEncoding
  }), [canDefaultInterval, canDefaultEndianness, modbusDeviceAddress, modbusRegisterBase, serialEncoding]);

  // Protocol configs + frame detection, derived from the Rust-parsed catalogue
  // (set by the async parse effect below).
  const EMPTY_INFO = { canConfig: undefined, serialConfig: undefined, modbusConfig: undefined, hasCanFrames: false, hasModbusFrames: false, hasSerialFrames: false } as const;
  const [parsedCatalogInfo, setParsedCatalogInfo] = useState<{
    canConfig?: ParsedCatalogTree["canConfig"];
    serialConfig?: ParsedCatalogTree["serialConfig"];
    modbusConfig?: ParsedCatalogTree["modbusConfig"];
    hasCanFrames: boolean;
    hasModbusFrames: boolean;
    hasSerialFrames: boolean;
  }>(EMPTY_INFO);

  const currentCanConfig = parsedCatalogInfo.canConfig;
  const currentSerialConfig = parsedCatalogInfo.serialConfig;
  const currentModbusConfig = parsedCatalogInfo.modbusConfig;

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

  // Wrapper to add frames with inferred protocol from catalog configs
  const handleAddFrameWithDefaults = useCallback(() => {
    // Infer protocol from which config exists in the catalog
    // Priority: single configured protocol > settings default > "can"
    const configuredProtocols: Array<"can" | "serial" | "modbus"> = [];
    if (currentCanConfig) configuredProtocols.push("can");
    if (currentSerialConfig) configuredProtocols.push("serial");
    if (currentModbusConfig) configuredProtocols.push("modbus");

    // If exactly one protocol is configured, use it
    if (configuredProtocols.length === 1) {
      handlers.handleAddFrame(configuredProtocols[0]);
      return;
    }

    // Otherwise fall back to settings default or "can"
    const protocol = settings?.default_frame_type || "can";
    handlers.handleAddFrame(protocol);
  }, [currentCanConfig, currentSerialConfig, currentModbusConfig, settings?.default_frame_type, handlers]);

  // Load default catalog on mount when settings are available
  useEffect(() => {
    if (settings) {
      handlers.loadDefaultCatalog();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings]);

  // Load catalog list on mount (refresh if the decoder dir changes). The dir is
  // resolved in Rust, so this must NOT gate on decoderDir being populated.
  useEffect(() => {
    listCatalogs().then(setCatalogs).catch(console.error);
  }, [decoderDir]);

  // Handler for opening catalog picker
  const handleOpenCatalogPicker = useCallback(() => {
    // Refresh catalog list before showing picker
    listCatalogs().then(setCatalogs).catch(console.error);
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

  // Parse the catalogue (in Rust, the canonical parser) and build the editor
  // tree from the resolved model. Async + debounced + cancellable so rapid
  // edits don't race; mirrors the diff effect's pattern.
  useEffect(() => {
    if (editMode !== "ui") return;

    const clear = () => {
      setTreeData({ nodes: [], hasCanFrames: false, hasSerialFrames: false, hasModbusFrames: false });
      setSelectedPath(null);
      setAvailablePeers([]);
      setAvailableSlaves([]);
      setParsedCatalogInfo(EMPTY_INFO);
    };

    if (!catalogContent) {
      clear();
      return;
    }

    let cancelled = false;
    const applyParsed = ({ tree, meta, peers, slaves, canConfig, serialConfig, modbusConfig, hasCanFrames, hasSerialFrames, hasModbusFrames }: ParsedCatalogTree) => {
      setTreeData({ nodes: tree, canConfig, serialConfig, modbusConfig, hasCanFrames, hasSerialFrames, hasModbusFrames });
      setParsedCatalogInfo({ canConfig, serialConfig, modbusConfig, hasCanFrames: !!hasCanFrames, hasModbusFrames: !!hasModbusFrames, hasSerialFrames: !!hasSerialFrames });
      if (meta) setMetaFields(meta);
      setAvailablePeers(peers);
      setAvailableSlaves(slaves);
      // Store CAN config from [meta.can] if present
      if (canConfig) {
        setCanDefaultEndianness(canConfig.default_endianness);
        setCanDefaultInterval(canConfig.default_interval);
        setCanDefaultExtended(canConfig.default_extended);
        setCanDefaultFd(canConfig.default_fd);
        // Convert frame_id_mask to hex string for display (or empty if not set)
        setCanFrameIdMask(canConfig.frame_id_mask !== undefined ? `0x${canConfig.frame_id_mask.toString(16).toUpperCase()}` : '');
        // Convert header fields from Record<name, field> to array form for editing
        if (canConfig.fields) {
          setCanHeaderFields(
            Object.entries(canConfig.fields).map(([name, field]) => ({
              name,
              mask: `0x${field.mask.toString(16).toUpperCase()}`,
              shift: field.shift,
              format: field.format ?? 'hex',
            }))
          );
        } else {
          setCanHeaderFields([]);
        }
      } else {
        // Reset fields when no CAN config
        setCanFrameIdMask('');
        setCanHeaderFields([]);
        setCanDefaultExtended(undefined);
        setCanDefaultFd(undefined);
      }
      // Store serial config from [meta.serial] if present
      if (serialConfig?.encoding) {
        setSerialEncoding(serialConfig.encoding);
        setSerialByteOrder(serialConfig.byte_order ?? 'big');
        // Convert header fields from Record<name, field> to array form for editing
        if (serialConfig.fields) {
          setSerialHeaderFields(
            Object.entries(serialConfig.fields).map(([name, field]) => ({
              name,
              mask: field.mask,
              endianness: field.endianness ?? 'big',
              format: field.format ?? 'hex',
            }))
          );
        } else {
          setSerialHeaderFields([]);
        }
        // Initialize header_length, max_frame_length, and checksum from parsed config
        setSerialHeaderLength(serialConfig.header_length);
        setSerialMaxFrameLength(serialConfig.max_frame_length);
        setSerialChecksum(serialConfig.checksum ?? null);
      } else {
        setSerialHeaderFields([]);
        setSerialHeaderLength(undefined);
        setSerialMaxFrameLength(undefined);
        setSerialChecksum(null);
      }
      // Store modbus config from [meta.modbus] if present
      if (modbusConfig) {
        setModbusDeviceAddress(modbusConfig.device_address ?? 1);
        setModbusRegisterBase(modbusConfig.register_base);
        setModbusDefaultInterval(modbusConfig.default_interval);
        setModbusDefaultByteOrder(modbusConfig.default_byte_order ?? "big");
        setModbusDefaultWordOrder(modbusConfig.default_word_order ?? "big");
      }

      // Keep selection stable by path; clear it if the node no longer exists.
      if (selectedPath) {
        const next = findNodeByPath(tree, selectedPath);
        if (!next) {
          setSelectedPath(null);
        }
      }
    };

    const handle = setTimeout(() => {
      parseCatalog(catalogContent)
        .then((cat) => {
          if (!cancelled) applyParsed(catalogToTree(cat));
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
        />
      }
    >
      {/* Bubble container */}
      <div className={`flex-1 flex flex-col min-h-0 rounded-lg border ${borderDataView} overflow-hidden`}>
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
            hasCanFrames={parsedCatalogInfo.hasCanFrames}
            hasModbusFrames={parsedCatalogInfo.hasModbusFrames}
            hasSerialFrames={parsedCatalogInfo.hasSerialFrames}
            canConfig={currentCanConfig}
            modbusConfig={currentModbusConfig}
            serialConfig={currentSerialConfig}
            onAddNode={handlers.handleAddNode}
            onAddCanFrame={handlers.handleAddCanFrame}
            onAddFrame={handleAddFrameWithDefaults}
            onExpandAll={expandAll}
            onCollapseAll={collapseAll}
          />
        )}

        <main className="flex-1 flex flex-col min-h-0 overflow-hidden">
          {migration && (
            <div className={`flex items-start gap-3 px-4 py-2.5 border-b ${borderWarning} ${bgWarning}`}>
              <div className="flex-1 text-xs">
                <p className={`font-medium ${textWarning}`}>
                  {t(
                    "editor.migrationBanner",
                    "Upgraded this catalogue to the latest format on load. Save to apply, or review the",
                  )}{" "}
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
                {migration.summary.length > 0 && (
                  <ul className="mt-1 list-disc list-inside text-[color:var(--text-muted)]">
                    {migration.summary.map((line, i) => (
                      <li key={i}>{line}</li>
                    ))}
                  </ul>
                )}
              </div>
              <button
                type="button"
                onClick={dismissMigration}
                aria-label={t("common.dismiss", "Dismiss")}
                className="text-[color:var(--text-muted)] hover:text-[color:var(--text-primary)]"
              >
                <X className={iconSm} />
              </button>
            </div>
          )}
          {editMode === "text" ? (
            <>
              {catalogPath && (
                <div className="flex items-center gap-1 px-3 py-1.5 border-b border-[color:var(--border-default)] bg-[var(--bg-surface)]">
                  <button
                    type="button"
                    onClick={() => setTextView("edit")}
                    className={`px-2.5 py-1 text-xs rounded ${textView === "edit" ? "bg-[var(--bg-primary)] text-[color:var(--text-primary)]" : "text-[color:var(--text-muted)]"}`}
                  >
                    {t("editor.textViewEdit", "Edit")}
                  </button>
                  <button
                    type="button"
                    onClick={() => setTextView("diff")}
                    className={`px-2.5 py-1 text-xs rounded ${textView === "diff" ? "bg-[var(--bg-primary)] text-[color:var(--text-primary)]" : "text-[color:var(--text-muted)]"}`}
                  >
                    {t("editor.textViewDiff", "Diff")}
                    {hasUnsavedChanges && <span className="ml-1.5 inline-block w-1.5 h-1.5 rounded-full bg-[var(--status-warning-text,#d97706)] align-middle" />}
                  </button>
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
            <div className="flex-1 p-6 overflow-y-auto overflow-x-hidden bg-[var(--bg-primary)]">
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
              ) : forms.editingId && !selectedNode ? (
                <CANFrameEditView
                  title={forms.editingFrameId ? t("editor.editCanFrameTitle") : t("editor.addCanFrameTitle")}
                  subtitle={
                    forms.editingFrameId
                      ? t("editor.editCanFrameDescription")
                      : t("editor.addCanFrameDescription")
                  }
                  idFields={idFields}
                  setIdFields={setIdFields}
                  availablePeers={availablePeers}
                  onCancel={() => {
                    forms.setEditingId(false);
                    forms.setEditingFrameId(null);
                  }}
                  onSave={handlers.handleSaveId}
                  primaryActionLabel={forms.editingFrameId ? t("editor.saveChanges") : t("editor.addFrameButton")}
                  disableSave={!idFields.id}
                />
              ) : !selectedNode ? (
                <EmptySelectionView />
              ) : (
                <div className="max-w-4xl">
                  <SelectionHeader
                    selectedNode={selectedNode}
                    formatFrameId={formatFrameIdForDisplay}
                    onEdit={selectedNode.type === "can-frame" && !forms.editingId ? () => handlers.handleEditId(selectedNode) : undefined}
                    onDelete={selectedNode.type === "can-frame" && !forms.editingId ? () => handlers.handleDeleteId(selectedNode.metadata?.idValue || selectedNode.key) : undefined}
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
                      catalogContent,
                      displayFrameIdFormat,
                      editingId: forms.editingId,
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
                    canConfigProps={{
                      canConfig: currentCanConfig,
                      onEditConfig: () => openDialog("config"),
                    }}
                    metaProps={{
                      metaFields: useCatalogEditorStore.getState().forms.meta,
                      canConfig: currentCanConfig,
                      serialConfig: currentSerialConfig,
                      modbusConfig: currentModbusConfig,
                      hasCanFrames: parsedCatalogInfo.hasCanFrames,
                      hasSerialFrames: parsedCatalogInfo.hasSerialFrames,
                      hasModbusFrames: parsedCatalogInfo.hasModbusFrames,
                      onEditMeta: () => openDialog("config"),
                    }}
                    muxProps={{
                      selectedNode,
                      catalogContent,
                      onAddCase: handlers.handleAddCase,
                      onEditMux: handlers.handleEditMux,
                      onDeleteMux: handlers.handleDeleteMux,
                      onSelectNode: (node) => setSelectedPath(node.path),
                    }}
                    muxCaseProps={{
                      selectedNode,
                      catalogContent,
                      onAddSignal: handlers.handleAddSignal,
                      onAddNestedMux: handlers.handleAddNestedMux,
                      onEditCase: handlers.handleEditCase,
                      onDeleteCase: handlers.handleDeleteCase,
                      onRequestDeleteSignal: (idKey, signalIndex, parentPath, signalName) =>
                        handlers.requestDeleteSignal(idKey, signalIndex, parentPath, signalName),
                      onSelectNode: (node) => setSelectedPath(node.path),
                    }}
                    signalProps={{
                      selectedNode,
                      catalogContent,
                      inheritedByteOrder: (() => {
                        const protocol = selectedNode?.path?.[1];
                        if (protocol === "can") return canDefaultEndianness;
                        if (protocol === "serial") return serialByteOrder;
                        return undefined;
                      })(),
                      onEditSignal: handlers.handleEditSignal,
                      onRequestDeleteSignal: handlers.requestDeleteSignal,
                      onSetValidation: (errors) => setValidation(errors),
                    }}
                    checksumProps={{
                      catalogContent,
                      onEditChecksum: handlers.handleEditChecksum,
                      onRequestDeleteChecksum: handlers.requestDeleteChecksum,
                      onSetValidation: (errors) => setValidation(errors),
                    }}
                    nodeProps={{
                      selectedNode,
                      catalogContent,
                      displayFrameIdFormat,
                      onSelectPath: (path) => setSelectedPath(path),
                      onSelectNode: (node) => setSelectedPath(node.path),
                      onAddCanFrameForNode: (nodeName) => {
                        setIdFields({
                          id: "",
                          length: 8,
                          transmitter: nodeName,
                          interval: undefined,
                          isIntervalInherited: false,
                          isLengthInherited: false,
                          isTransmitterInherited: false,
                        });
                        forms.setEditingId(true);
                        setSelectedPath(null);
                      },
                      onAddRegisterForSlave: (slaveAddress) => {
                        forms.setFrameFields({
                          protocol: "modbus",
                          config: { protocol: "modbus", register_type: "holding", node_address: slaveAddress },
                          base: { length: 1 },
                          modbusFrameKey: "",
                        });
                        forms.setEditingFrameOriginalKey(null);
                        forms.setEditingFrame(true);
                        setSelectedPath(null);
                      },
                      onEditNode: handlers.handleEditNode,
                      onDeleteNode: handlers.handleRequestDeleteNode,
                      onRequestDeleteFrame: handlers.handleDeleteId,
                      onRequestDeleteRegister: (key) => handlers.handleDeleteFrame("modbus", key),
                      onRequestDeleteSignal: (idKey, index, parentPath, signalName) =>
                        handlers.requestDeleteSignal(idKey, index, parentPath, signalName),
                    }}
                    arrayProps={{
                      selectedNode,
                    }}
                    valueProps={{
                      selectedNode,
                    }}
                    modbusFrameProps={{
                      onEditFrame: handlers.handleEditFrame,
                      onDeleteFrame: (key) => handlers.handleDeleteFrame("modbus", key),
                    }}
                    modbusConfigProps={{
                      modbusConfig: currentModbusConfig,
                      onEditConfig: () => openDialog("config"),
                    }}
                    serialFrameProps={{
                      catalogContent,
                      editingSignal: forms.editingSignal,
                      onEditFrame: handlers.handleEditFrame,
                      onDeleteFrame: (key) => handlers.handleDeleteFrame("serial", key),
                      onEditSerialConfig: () => openDialog("config"),
                      onAddSignal: (idKey) => handlers.handleAddSignal(idKey, ["frame", "serial", idKey]),
                      onEditSignal: handlers.handleEditSignal,
                      onRequestDeleteSignal: handlers.requestDeleteSignal,
                      onAddMux: (idKey) => handlers.handleAddMux(idKey, ["frame", "serial", idKey]),
                    }}
                    serialConfigProps={{
                      onEditConfig: () => openDialog("config"),
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
        catalogs={catalogs}
        selectedPath={catalogPath}
        decoderDir={decoderDir}
        onSelect={handleSelectCatalog}
        onImport={(path, content) => openSuccess(path, content)}
        onImportError={(message) => setValidation([{ field: "import", message }])}
        onNewCatalog={handlers.handleNewCatalog}
      />
    </AppLayout>
  );
}

export default withFrameIdFormat(CatalogEditorInner);
