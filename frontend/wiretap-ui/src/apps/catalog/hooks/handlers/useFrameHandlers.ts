// ui/src/apps/catalog/hooks/handlers/useFrameHandlers.ts
// Frame, node, and config operations for catalog editor

import { useCatalogEditorStore } from "../../../../stores/catalogEditorStore";
import {
  saveFrameToml,
  deleteFrameToml,
  addNodeToml,
  editNodeToml,
  deleteNodeToml,
  deleteTomlAtPath,
  metaOp,
  deleteOp,
  canConfigOp,
  serialConfigOp,
  modbusConfigOp,
} from "../../editorOps";
import { editCatalogOps, validateFrameWs } from "../../../../api/catalog";
import type { EditOp } from "../../../../types/catalogEdit";
import type { FrameEditFields } from "../../views/FrameEditView";
import { createDefaultFrameFields, frameEditFieldsFor, frameFieldsOf, frameKeyOf } from "../../views/frameEditUtils";
import { frameAt } from "../../model";
import type { ProtocolType } from "../../types";
import { showRefusal } from "./refusal";

export interface UseFrameHandlersParams {
  frameFields?: FrameEditFields;
  editingFrameOriginalKey?: string | null;
  setEditingFrame?: (v: boolean) => void;
  setFrameFields?: (v: FrameEditFields) => void;
  setEditingFrameOriginalKey?: (v: string | null) => void;
}

export function useFrameHandlers({
  frameFields,
  editingFrameOriginalKey,
  setEditingFrame,
  setFrameFields,
  setEditingFrameOriginalKey,
}: UseFrameHandlersParams) {
  const catalogContent = useCatalogEditorStore((s) => s.content.toml);
  const catalog = useCatalogEditorStore((s) => s.tree.catalog);
  const setToml = useCatalogEditorStore((s) => s.setToml);

  const forms = useCatalogEditorStore((s) => s.forms);
  const { nodeName, nodeNotes, nodeDeviceAddress } = forms;
  const setNodeName = useCatalogEditorStore((s) => s.setNodeName);
  const setNodeNotes = useCatalogEditorStore((s) => s.setNodeNotes);
  const setNodeDeviceAddress = useCatalogEditorStore((s) => s.setNodeDeviceAddress);

  const dialogPayload = useCatalogEditorStore((s) => s.ui.dialogPayload);
  const availablePeers = useCatalogEditorStore((s) => s.ui.availablePeers);
  const openDialog = useCatalogEditorStore((s) => s.openDialog);
  const closeDialog = useCatalogEditorStore((s) => s.closeDialog);
  const setDialogPayload = useCatalogEditorStore((s) => s.setDialogPayload);

  const setValidation = useCatalogEditorStore((s) => s.setValidation);
  const clearValidation = useCatalogEditorStore((s) => s.clearValidation);
  const setSelectedPath = useCatalogEditorStore((s) => s.setSelectedPath);
  const selectedPath = useCatalogEditorStore((s) => s.tree.selectedPath);

  // ============================================================================
  // Frames
  // ============================================================================

  const handleDeleteId = (idKey: string) => {
    setDialogPayload({ idToDelete: idKey });
    openDialog("deleteCanFrame");
  };

  const handleConfirmDeleteId = async () => {
    if (!dialogPayload.idToDelete) return;

    try {
      const newContent = await deleteFrameToml(catalogContent, "can", dialogPayload.idToDelete);
      setToml(newContent);
      closeDialog("deleteCanFrame");
      setDialogPayload({ idToDelete: null });
      setSelectedPath(null);
    } catch (error) {
      console.error("Failed to delete ID:", error);
      setValidation([{ field: "canid", message: "Failed to delete ID" }]);
    }
  };

  const openFrameEditor = (fields: FrameEditFields, originalKey: string | null) => {
    if (!setEditingFrame || !setFrameFields || !setEditingFrameOriginalKey) return;
    setFrameFields(fields);
    setEditingFrameOriginalKey(originalKey);
    setEditingFrame(true);
    setSelectedPath(null);
    clearValidation();
  };

  const handleAddFrame = (protocol: ProtocolType = "can", seed?: { transmitter?: string; nodeAddress?: number }) => {
    const fields = createDefaultFrameFields(protocol);
    if (seed?.transmitter) fields.base.transmitter = seed.transmitter;
    if (seed?.nodeAddress !== undefined && fields.config.protocol === "modbus") fields.config.node_address = seed.nodeAddress;
    openFrameEditor(fields, null);
  };

  const handleEditFrame = (node: { path: string[] }) => {
    const frame = frameAt(catalog, node.path);
    if (frame) openFrameEditor(frameEditFieldsFor(frame, catalog), frame.key);
  };

  const handleSaveFrame = async () => {
    if (!frameFields || !setEditingFrame) return;

    const frameKey = frameKeyOf(frameFields);
    if (!frameKey) {
      setValidation([{ field: "frame", message: "Frame identifier is required" }]);
      return;
    }

    const existingKeys = (catalog?.frames ?? []).filter((f) => f.protocol === frameFields.protocol).map((f) => f.key);
    const cfg = frameFields.config;
    const allErrors = await validateFrameWs({
      protocol: frameFields.protocol,
      key: frameKey,
      length: frameFields.base.length,
      transmitter: frameFields.base.transmitter,
      interval: frameFields.base.interval,
      maxLength: frameFields.protocol === "can" ? 64 : 256,
      extended: cfg.protocol === "can" ? cfg.extended : undefined,
      registerNumber: cfg.protocol === "modbus" ? cfg.register_number : undefined,
      nodeAddress: cfg.protocol === "modbus" ? cfg.node_address : undefined,
      registerType: cfg.protocol === "modbus" ? cfg.register_type : undefined,
      delimiter: cfg.protocol === "serial" ? cfg.delimiter : undefined,
      existingKeys,
      originalKey: editingFrameOriginalKey ?? undefined,
      availablePeers,
    });

    if (allErrors.length > 0) {
      setValidation(allErrors);
      return;
    }

    try {
      setToml(await saveFrameToml(catalogContent, frameFields.protocol, frameKey, frameFieldsOf(frameFields), editingFrameOriginalKey ?? null));
      setEditingFrame(false);
      if (setEditingFrameOriginalKey) setEditingFrameOriginalKey(null);
      clearValidation();
    } catch (error) {
      showRefusal("frame", error);
    }
  };

  const handleDeleteFrame = async (protocol: ProtocolType, key: string) => {
    try {
      const newContent = await deleteFrameToml(catalogContent, protocol, key);
      setToml(newContent);
      setSelectedPath(null);
    } catch (error) {
      console.error("Failed to delete frame:", error);
      setValidation([{ field: "frame", message: "Failed to delete frame" }]);
    }
  };

  const handleCancelFrameEdit = () => {
    if (setEditingFrame) setEditingFrame(false);
    if (setEditingFrameOriginalKey) setEditingFrameOriginalKey(null);
    clearValidation();
  };

  // ============================================================================
  // Node operations
  // ============================================================================

  const handleRequestDeleteNode = (nodeNameToDelete: string) => {
    setDialogPayload({ nodeToDelete: nodeNameToDelete });
    openDialog("deleteNode");
  };

  const handleConfirmDeleteNode = async () => {
    const nodeNameToDelete = dialogPayload.nodeToDelete;
    if (!nodeNameToDelete) return;

    try {
      const newContent = await deleteNodeToml(catalogContent, nodeNameToDelete);
      setToml(newContent);
      setSelectedPath(null);
    } catch (error) {
      console.error("Failed to delete node:", error);
      setValidation([{ field: "node", message: "Failed to delete node" }]);
    } finally {
      closeDialog("deleteNode");
      setDialogPayload({ nodeToDelete: null });
    }
  };

  const handleAddNode = () => {
    setNodeName("");
    setNodeNotes("");
    setNodeDeviceAddress(undefined);
    openDialog("addNode");
  };

  const handleSaveNode = async () => {
    if (!nodeName.trim()) return;

    try {
      const notesToSave = nodeNotes.trim() || undefined;
      const newContent = await addNodeToml(catalogContent, nodeName, notesToSave, nodeDeviceAddress);
      setToml(newContent);
      closeDialog("addNode");
      setNodeName("");
      setNodeNotes("");
      setNodeDeviceAddress(undefined);
    } catch (error) {
      console.error("Failed to add node:", error);
    }
  };

  const handleEditNode = (originalName: string, notes?: string, deviceAddress?: number) => {
    setDialogPayload({ editingNodeOriginalName: originalName });
    setNodeName(originalName);
    setNodeNotes(notes || "");
    setNodeDeviceAddress(deviceAddress);
    openDialog("editNode");
  };

  const handleSaveEditNode = async () => {
    if (!nodeName.trim()) return;

    const originalName = dialogPayload.editingNodeOriginalName;
    if (!originalName) return;

    try {
      const notesToSave = nodeNotes.trim() || undefined;
      const { toml: newContent, success, error } = await editNodeToml(
        catalogContent,
        originalName,
        nodeName,
        notesToSave,
        nodeDeviceAddress
      );

      if (!success) {
        setValidation([{ field: "node", message: error || "Failed to edit node" }]);
        return;
      }

      setToml(newContent);
      closeDialog("editNode");
      setNodeName("");
      setNodeNotes("");
      setNodeDeviceAddress(undefined);
      setDialogPayload({ editingNodeOriginalName: null });
      clearValidation();

      if (originalName !== nodeName && selectedPath) {
        const newPath = ["node", nodeName];
        setSelectedPath(newPath);
      }
    } catch (error) {
      console.error("Failed to edit node:", error);
      setValidation([{ field: "node", message: "Failed to edit node" }]);
    }
  };

  // ============================================================================
  // Generic delete
  // ============================================================================

  const handleRequestDeleteGeneric = (path: string[], label?: string) => {
    setDialogPayload({ genericPathToDelete: path, genericLabel: label || null });
    openDialog("deleteGeneric");
  };

  const handleConfirmDeleteGeneric = async () => {
    const path = dialogPayload.genericPathToDelete;
    if (!path) return;
    try {
      const newContent = await deleteTomlAtPath(catalogContent, path);
      setToml(newContent);
      setSelectedPath(null);
    } catch (error) {
      console.error("Failed to delete item:", error);
      setValidation([{ field: "generic", message: "Failed to delete item" }]);
    } finally {
      closeDialog("deleteGeneric");
      setDialogPayload({ genericPathToDelete: null, genericLabel: null });
    }
  };

  // ============================================================================
  // Protocol config operations
  // ============================================================================

  /** Meta plus each enabled protocol's config; a disabled one is deleted. */
  const handleSaveConfig = async (enabledConfigs: { can: boolean; serial: boolean; modbus: boolean }) => {
    const ops: EditOp[] = [metaOp(forms.meta)];
    ops.push(
      enabledConfigs.can
        ? canConfigOp({
            default_byte_order: forms.canDefaultEndianness,
            default_interval: forms.canDefaultInterval,
            default_extended: forms.canDefaultExtended,
            default_fd: forms.canDefaultFd,
            frame_id_mask: forms.canFrameIdMask,
            fields: Object.fromEntries(
              forms.canHeaderFields.map((f) => [f.name, { mask: f.mask, shift: f.shift, format: f.format }]),
            ),
          })
        : deleteOp(["meta", "can"]),
    );
    const checksum = forms.serialChecksum;
    ops.push(
      enabledConfigs.serial
        ? serialConfigOp({
            encoding: forms.serialEncoding,
            byte_order: forms.serialByteOrder,
            header_length: forms.serialHeaderLength,
            frame_id_mask: catalog?.serial?.frameIdMask,
            min_frame_length: catalog?.serial?.minFrameLength,
            fields: Object.fromEntries(
              forms.serialHeaderFields.map((f) => [f.name, { mask: f.mask, endianness: f.endianness, format: f.format }]),
            ),
            checksum: checksum ? {
              algorithm: checksum.algorithm,
              startByte: checksum.start_byte,
              byteLength: checksum.byte_length,
              calcStartByte: checksum.calc_start_byte,
              calcEndByte: checksum.calc_end_byte,
              bigEndian: checksum.big_endian,
            } : undefined,
          })
        : deleteOp(["meta", "serial"]),
    );
    ops.push(
      enabledConfigs.modbus
        ? modbusConfigOp({
            device_address: catalog?.modbus?.deviceAddress,
            register_base: forms.modbusRegisterBase,
            default_interval: forms.modbusDefaultInterval,
            default_byte_order: forms.modbusDefaultByteOrder,
            default_word_order: forms.modbusDefaultWordOrder,
          })
        : deleteOp(["meta", "modbus"]),
    );

    try {
      setToml(await editCatalogOps(catalogContent, ops));
      closeDialog("config");
      clearValidation();
    } catch (error) {
      showRefusal("config", error);
    }
  };

  return {
    handleDeleteId,
    handleConfirmDeleteId,
    handleAddFrame,
    handleEditFrame,
    handleSaveFrame,
    handleDeleteFrame,
    handleCancelFrameEdit,

    // Node operations
    handleRequestDeleteNode,
    handleConfirmDeleteNode,
    handleAddNode,
    handleSaveNode,
    handleEditNode,
    handleSaveEditNode,

    // Generic delete
    handleRequestDeleteGeneric,
    handleConfirmDeleteGeneric,

    // Unified config operations
    handleSaveConfig,
  };
}
