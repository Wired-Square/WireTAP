// ui/src/apps/catalog/CatalogEditor.tsx

import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { listen } from "@tauri-apps/api/event";
import { useSettings, getDisplayFrameIdFormat, getSaveFrameIdFormat } from "../../hooks/useSettings";
import { useCatalogEditorStore } from "../../stores/catalogEditorStore";
import { useFocusStore } from "../../stores/focusStore";
import { listCatalogs, type CatalogMetadata } from "../../api/catalog";
import { Eye } from "lucide-react";
import AppLayout from "../../components/AppLayout";
import { borderDataView, bgDataView } from "../../styles/colourTokens";
import CatalogTreePanel from "./layouts/CatalogTreePanel";
import CatalogToolbar from "./layouts/CatalogToolbar";
import SelectionHeader from "./layouts/SelectionHeader";
import { parseTomlToTree } from "./toml";
import type { TomlNode } from "./types";
import { findNodeByPath } from "./tree/treeUtils";
import { formatFrameId } from "./utils";
import { createRenderTreeNode } from "./tree/renderTreeNode";
import EditorViewRouter from "./views/EditorViewRouter";
import TextModeView from "./views/TextModeView";
import EmptySelectionView from "./views/EmptySelectionView";
import CANFrameEditView from "./views/CANFrameEditView";
import FrameEditView from "./views/FrameEditView";
import { isFrameFieldsValid } from "./views/frameEditUtils";
import FindBar from "./components/FindBar";
import TextFindBar from "./components/TextFindBar";
import CatalogDialogs from "./components/CatalogDialogs";
import CatalogPickerDialog from "./dialogs/CatalogPickerDialog";
import { useCatalogForms, useCatalogHandlers } from "./hooks";
import { openCatalogAtPath } from "./io";

export default function CatalogEditor() {
  // Zustand store selectors
  const catalogPath = useCatalogEditorStore((s) => s.file.path);
  const catalogContent = useCatalogEditorStore((s) => s.content.toml);
  const originalContent = useCatalogEditorStore((s) => s.content.lastSavedToml);
  const reloadVersion = useCatalogEditorStore((s) => s.content.reloadVersion);
  const setToml = useCatalogEditorStore((s) => s.setToml);
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
  const filterByNode = useCatalogEditorStore((s) => s.ui.filterByNode);
  const setFilterByNode = useCatalogEditorStore((s) => s.setFilterByNode);
  const openFind = useCatalogEditorStore((s) => s.openFind);
  const openTextFind = useCatalogEditorStore((s) => s.openTextFind);
  const openSuccess = useCatalogEditorStore((s) => s.openSuccess);
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

  // Load settings
  const { settings } = useSettings();
  const displayFrameIdFormat = getDisplayFrameIdFormat(settings);
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
  const catalogDefaults = useMemo(() => ({
    interval: canDefaultInterval,           // From [frame.can.config], stored in forms.canDefaultInterval
    endianness: canDefaultEndianness,       // From [frame.can.config], stored in forms.canDefaultEndianness
    modbusDeviceAddress,  // From [frame.modbus.config], stored in forms.modbusDeviceAddress
    modbusRegisterBase,   // From [frame.modbus.config], stored in forms.modbusRegisterBase
    serialEncoding,       // From [frame.serial.config], stored in forms.serialEncoding
  }), [canDefaultInterval, canDefaultEndianness, modbusDeviceAddress, modbusRegisterBase, serialEncoding]);

  // Get current protocol configs and frame detection from TOML
  const parsedCatalogInfo = useMemo(() => {
    if (!catalogContent) return { canConfig: undefined, serialConfig: undefined, modbusConfig: undefined, hasCanFrames: false, hasModbusFrames: false, hasSerialFrames: false };
    try {
      const { canConfig, serialConfig, modbusConfig, hasCanFrames, hasModbusFrames, hasSerialFrames } = parseTomlToTree(catalogContent);
      return { canConfig, serialConfig, modbusConfig, hasCanFrames: !!hasCanFrames, hasModbusFrames: !!hasModbusFrames, hasSerialFrames: !!hasSerialFrames };
    } catch {
      return { canConfig: undefined, serialConfig: undefined, modbusConfig: undefined, hasCanFrames: false, hasModbusFrames: false, hasSerialFrames: false };
    }
  }, [catalogContent]);

  const currentCanConfig = parsedCatalogInfo.canConfig;
  const currentSerialConfig = parsedCatalogInfo.serialConfig;
  const currentModbusConfig = parsedCatalogInfo.modbusConfig;

  // Computed values
  const hasUnsavedChanges = useMemo(() => {
    return catalogContent !== originalContent && originalContent !== "";
  }, [catalogContent, originalContent]);

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

  // Load catalog list when decoder dir is available
  useEffect(() => {
    if (decoderDir) {
      listCatalogs(decoderDir).then(setCatalogs).catch(console.error);
    }
  }, [decoderDir]);

  // Handler for opening catalog picker
  const handleOpenCatalogPicker = useCallback(() => {
    // Refresh catalog list before showing picker
    if (decoderDir) {
      listCatalogs(decoderDir).then(setCatalogs).catch(console.error);
    }
    setShowCatalogPicker(true);
  }, [decoderDir]);

  // Handler for selecting a catalog from the picker
  const handleSelectCatalog = useCallback(async (path: string) => {
    try {
      const content = await openCatalogAtPath(path);
      openSuccess(path, content);
    } catch (error) {
      console.error("Failed to open catalog:", error);
    }
  }, [openSuccess]);

  // Parse TOML content whenever it changes
  useEffect(() => {
    if (editMode !== "ui") return;

    if (!catalogContent) {
      setTreeData({ nodes: [], hasCanFrames: false, hasSerialFrames: false, hasModbusFrames: false });
      setSelectedPath(null);
      setAvailablePeers([]);
      return;
    }

    try {
      const { tree, meta, peers, canConfig, serialConfig, modbusConfig, hasCanFrames, hasSerialFrames, hasModbusFrames } = parseTomlToTree(catalogContent);
      setTreeData({ nodes: tree, canConfig, serialConfig, modbusConfig, hasCanFrames, hasSerialFrames, hasModbusFrames });
      if (meta) setMetaFields(meta);
      setAvailablePeers(peers);
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
      // Store modbus config from [frame.modbus.config] if present
      if (modbusConfig) {
        setModbusDeviceAddress(modbusConfig.device_address);
        setModbusRegisterBase(modbusConfig.register_base);
      }

      // Keep selection stable by path; clear it if the node no longer exists.
      if (selectedPath) {
        const next = findNodeByPath(tree, selectedPath);
        if (!next) {
          setSelectedPath(null);
        }
      }
    } catch (e) {
      console.warn("Failed to parse TOML to tree:", e);
      setTreeData({ nodes: [], hasCanFrames: false, hasSerialFrames: false, hasModbusFrames: false });
      setSelectedPath(null);
      setAvailablePeers([]);
    }
    // Include reloadVersion to trigger re-parse on reload (even if content unchanged)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [catalogContent, reloadVersion, editMode]);

  // Listen for Find menu event from native Edit menu
  useEffect(() => {
    const unlisten = listen("menu-find", () => {
      if (editMode === "text") {
        openTextFind();
      } else {
        openFind();
      }
    });

    return () => {
      unlisten.then((fn) => fn());
    };
  }, [editMode, openFind, openTextFind]);

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
      filterByNode,
      onNodeClick: handleNodeClick,
      onToggleExpand: handleToggleExpand,
      formatFrameId: formatFrameIdForDisplay,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expandedNodes, selectedNode, filterByNode, formatFrameIdForDisplay]);

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
        {editMode === "ui" && catalogPath && <FindBar />}

        <div className={`flex-1 flex min-h-0 overflow-hidden ${bgDataView}`}>
        {/* Tree View Panel - Only show in UI mode */}
        {editMode === "ui" && (
          <CatalogTreePanel
            visible={editMode === "ui"}
            catalogPath={catalogPath}
            parsedTree={parsedTree}
            renderTreeNode={renderTreeNode}
            scrollRef={treeScrollRef}
            onScroll={handleTreeScroll}
            availablePeers={availablePeers}
            filterByNode={filterByNode}
            setFilterByNode={setFilterByNode}
            hasCanFrames={parsedCatalogInfo.hasCanFrames}
            hasModbusFrames={parsedCatalogInfo.hasModbusFrames}
            hasSerialFrames={parsedCatalogInfo.hasSerialFrames}
            canConfig={currentCanConfig}
            modbusConfig={currentModbusConfig}
            serialConfig={currentSerialConfig}
            onAddNode={handlers.handleAddNode}
            onAddCanFrame={handlers.handleAddCanFrame}
            onAddFrame={handleAddFrameWithDefaults}
            onEditConfig={() => openDialog("config")}
          />
        )}

        <main className="flex-1 flex flex-col min-h-0 overflow-hidden">
          {editMode === "text" ? (
            <>
              {catalogPath && <TextFindBar textareaRef={textareaRef} />}
              <TextModeView
                ref={textareaRef}
                toml={catalogContent}
                onChangeToml={setToml}
                placeholder="Open a catalog file to edit..."
                isDisabled={!catalogPath}
              />
            </>
          ) : (
            <div className="flex-1 p-6 overflow-y-auto overflow-x-hidden bg-[var(--bg-primary)]">
              {!catalogPath ? (
                <div className="flex items-center justify-center h-full text-[color:var(--text-muted)]">
                  <div className="text-center">
                    <Eye className="w-12 h-12 mx-auto mb-4 opacity-50" />
                    <p>Open a catalog file to view in UI mode</p>
                  </div>
                </div>
              ) : forms.editingFrame && !selectedNode ? (
                <FrameEditView
                  title={forms.editingFrameOriginalKey ? "Edit Frame" : "Add New Frame"}
                  subtitle={
                    forms.editingFrameOriginalKey
                      ? "Modify frame definition"
                      : "Create a new frame definition"
                  }
                  fields={forms.frameFields}
                  setFields={forms.setFrameFields}
                  availablePeers={availablePeers}
                  allowProtocolChange={!forms.editingFrameOriginalKey}
                  defaults={catalogDefaults}
                  onCancel={handlers.handleCancelFrameEdit}
                  onSave={handlers.handleSaveFrame}
                  primaryActionLabel={forms.editingFrameOriginalKey ? "Save Changes" : "Add Frame"}
                  disableSave={!isFrameFieldsValid(forms.frameFields)}
                />
              ) : forms.editingId && !selectedNode ? (
                <CANFrameEditView
                  title={forms.editingFrameId ? "Edit CAN Frame" : "Add New CAN Frame"}
                  subtitle={
                    forms.editingFrameId
                      ? "Modify CAN message definition"
                      : "Create a new CAN message definition"
                  }
                  idFields={idFields}
                  setIdFields={setIdFields}
                  availablePeers={availablePeers}
                  onCancel={() => {
                    forms.setEditingId(false);
                    forms.setEditingFrameId(null);
                  }}
                  onSave={handlers.handleSaveId}
                  primaryActionLabel={forms.editingFrameId ? "Save Changes" : "Add Frame"}
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
                      onEditNode: handlers.handleEditNode,
                      onDeleteNode: handlers.handleRequestDeleteNode,
                      onRequestDeleteFrame: handlers.handleDeleteId,
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
