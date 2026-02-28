// ui/src/apps/catalog/hooks/handlers/useFrameHandlers.ts
// Frame, node, and config operations for catalog editor

import { useCatalogEditorStore } from "../../../../stores/catalogEditorStore";
import { tomlParse } from "../../toml";
import {
  upsertCanFrameToml,
  deleteCanFrameToml,
  upsertFrameToml,
  deleteFrameToml,
  getFrameKeys,
  addNodeToml,
  editNodeToml,
  deleteNodeToml,
  deleteTomlAtPath,
  upsertSerialConfigToml,
  upsertModbusConfigToml,
  upsertCanConfigToml,
  deleteCanConfigToml,
  deleteSerialConfigToml,
  deleteModbusConfigToml,
  updateMetaToml,
} from "../../editorOps";
import {
  validateCanFrameFields,
  validateFrameConfig,
  validateCommonFrameFields,
} from "../../validate";
import { protocolRegistry } from "../../protocols";
import type { FrameEditFields } from "../../views/FrameEditView";
import type { ProtocolType, CANConfig, SerialConfig } from "../../types";

export interface UseFrameHandlersParams {
  // CAN frame editing (legacy)
  editingFrameId: string | null;
  setEditingId: (v: boolean) => void;
  setEditingFrameId: (v: string | null) => void;
  // Generic frame editing
  frameFields?: FrameEditFields;
  editingFrameOriginalKey?: string | null;
  setEditingFrame?: (v: boolean) => void;
  setFrameFields?: (v: FrameEditFields) => void;
  setEditingFrameOriginalKey?: (v: string | null) => void;
}

export function useFrameHandlers({
  editingFrameId,
  setEditingId,
  setEditingFrameId,
  frameFields,
  editingFrameOriginalKey,
  setEditingFrame,
  setFrameFields,
  setEditingFrameOriginalKey,
}: UseFrameHandlersParams) {
  // Store selectors
  const catalogContent = useCatalogEditorStore((s) => s.content.toml);
  const setToml = useCatalogEditorStore((s) => s.setToml);

  const idFields = useCatalogEditorStore((s) => s.forms.canFrame);
  const nodeName = useCatalogEditorStore((s) => s.forms.nodeName);
  const nodeNotes = useCatalogEditorStore((s) => s.forms.nodeNotes);
  const serialEncoding = useCatalogEditorStore((s) => s.forms.serialEncoding);
  const serialByteOrder = useCatalogEditorStore((s) => s.forms.serialByteOrder);
  const modbusDeviceAddress = useCatalogEditorStore((s) => s.forms.modbusDeviceAddress);
  const modbusRegisterBase = useCatalogEditorStore((s) => s.forms.modbusRegisterBase);
  const modbusDefaultInterval = useCatalogEditorStore((s) => s.forms.modbusDefaultInterval);
  const modbusDefaultByteOrder = useCatalogEditorStore((s) => s.forms.modbusDefaultByteOrder);
  const modbusDefaultWordOrder = useCatalogEditorStore((s) => s.forms.modbusDefaultWordOrder);
  const canDefaultEndianness = useCatalogEditorStore((s) => s.forms.canDefaultEndianness);
  const canDefaultInterval = useCatalogEditorStore((s) => s.forms.canDefaultInterval);
  const canDefaultExtended = useCatalogEditorStore((s) => s.forms.canDefaultExtended);
  const canDefaultFd = useCatalogEditorStore((s) => s.forms.canDefaultFd);
  const canFrameIdMask = useCatalogEditorStore((s) => s.forms.canFrameIdMask);
  const canHeaderFields = useCatalogEditorStore((s) => s.forms.canHeaderFields);
  const metaFields = useCatalogEditorStore((s) => s.forms.meta);
  const serialHeaderFields = useCatalogEditorStore((s) => s.forms.serialHeaderFields);
  const serialHeaderLength = useCatalogEditorStore((s) => s.forms.serialHeaderLength);
  const serialMaxFrameLength = useCatalogEditorStore((s) => s.forms.serialMaxFrameLength);
  const serialChecksum = useCatalogEditorStore((s) => s.forms.serialChecksum);
  const setIdFields = useCatalogEditorStore((s) => s.setCanFrameForm);
  const setNodeName = useCatalogEditorStore((s) => s.setNodeName);
  const setNodeNotes = useCatalogEditorStore((s) => s.setNodeNotes);

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
  // CAN Frame operations (legacy - for backwards compatibility)
  // ============================================================================

  const handleEditId = (node: any) => {
    if (node.type === "can-frame" && node.metadata) {
      const originalId = node.metadata.idValue || node.key;
      setIdFields({
        id: originalId,
        length: node.metadata.lengthInherited ? 8 : node.metadata.length || 8,
        transmitter: node.metadata.transmitterInherited ? undefined : node.metadata.transmitter,
        interval: node.metadata.intervalInherited ? undefined : node.metadata.interval,
        isIntervalInherited: node.metadata.intervalInherited || false,
        isLengthInherited: node.metadata.lengthInherited || false,
        isTransmitterInherited: node.metadata.transmitterInherited || false,
        notes: node.metadata.notes,
      });

      setEditingFrameId(originalId);
      setEditingId(true);
      setSelectedPath(null);
      clearValidation();
    }
  };

  const handleSaveId = () => {
    if (!idFields.id) return;

    const oldId = editingFrameId;

    try {
      const parsedForValidation = tomlParse(catalogContent) as any;
      const existingIds = parsedForValidation?.frame?.can
        ? Object.keys(parsedForValidation.frame.can)
        : [];

      const errors = validateCanFrameFields(
        {
          id: idFields.id,
          length: idFields.length,
          transmitter: idFields.transmitter,
          interval: idFields.interval,
        },
        {
          existingIds,
          oldId,
          availablePeers,
        }
      );

      if (errors.length > 0) {
        setValidation(errors);
        return;
      }
    } catch {
      setValidation([{ field: "toml", message: "TOML is invalid; fix syntax errors before saving" }]);
      return;
    }

    try {
      const newContent = upsertCanFrameToml(catalogContent, {
        oldId,
        id: idFields.id,
        length: idFields.length,
        transmitter: idFields.transmitter,
        interval: idFields.interval,
        isLengthInherited: idFields.isLengthInherited,
        isTransmitterInherited: idFields.isTransmitterInherited,
        isIntervalInherited: idFields.isIntervalInherited,
        notes: idFields.notes,
      });

      setToml(newContent);
      setEditingId(false);
      setEditingFrameId(null);
      clearValidation();
    } catch (error) {
      console.error("Failed to save ID:", error);
      setValidation([{ field: "can-frame", message: "Failed to save CAN frame" }]);
    }
  };

  const handleDeleteId = (idKey: string) => {
    setDialogPayload({ idToDelete: idKey });
    openDialog("deleteCanFrame");
  };

  const handleConfirmDeleteId = () => {
    if (!dialogPayload.idToDelete) return;

    try {
      const newContent = deleteCanFrameToml(catalogContent, dialogPayload.idToDelete);
      setToml(newContent);
      closeDialog("deleteCanFrame");
      setDialogPayload({ idToDelete: null });
      setSelectedPath(null);
    } catch (error) {
      console.error("Failed to delete ID:", error);
      setValidation([{ field: "canid", message: "Failed to delete ID" }]);
    }
  };

  const handleAddCanFrame = () => {
    setIdFields({
      id: "",
      length: 8,
      transmitter: undefined,
      interval: undefined,
      isIntervalInherited: false,
      isLengthInherited: false,
      isTransmitterInherited: false,
    });

    setEditingFrameId(null);
    setEditingId(true);
    setSelectedPath(null);
    clearValidation();
  };

  // ============================================================================
  // Generic Frame Operations (CAN, Modbus, Serial)
  // ============================================================================

  /**
   * Get the frame key from FrameEditFields based on protocol type
   */
  const getFrameKeyFromFields = (fields: FrameEditFields): string => {
    switch (fields.protocol) {
      case "can":
        return (fields.config as CANConfig).id || "";
      case "modbus":
        return fields.modbusFrameKey || "";
      case "serial":
        return (fields.config as SerialConfig).frame_id || "";
      default:
        return "";
    }
  };

  /**
   * Handle adding a new frame (opens the generic frame editor)
   */
  const handleAddFrame = (protocol: ProtocolType = "can") => {
    if (!setEditingFrame || !setFrameFields || !setEditingFrameOriginalKey) return;

    const handler = protocolRegistry.get(protocol);
    if (!handler) return;

    const defaultConfig = handler.getDefaultConfig();
    setFrameFields({
      protocol,
      config: defaultConfig,
      base: {
        length: protocol === "can" ? 8 : protocol === "modbus" ? 1 : 0,
      },
      modbusFrameKey: protocol === "modbus" ? "" : undefined,
    });
    setEditingFrameOriginalKey(null);
    setEditingFrame(true);
    setSelectedPath(null);
    clearValidation();
  };

  /**
   * Handle editing an existing frame (opens the generic frame editor)
   */
  const handleEditFrame = (node: any) => {
    if (!setEditingFrame || !setFrameFields || !setEditingFrameOriginalKey) return;

    const protocol = node.metadata?.frameType as ProtocolType;
    if (!protocol) return;

    const handler = protocolRegistry.get(protocol);
    if (!handler) return;

    let config;
    let modbusFrameKey: string | undefined;

    switch (protocol) {
      case "can": {
        const idKey = node.metadata?.idValue || node.key;
        config = {
          protocol: "can" as const,
          id: idKey,
          extended: node.metadata?.extended,
          bus: node.metadata?.bus,
          copy: node.metadata?.copyFrom,
        };
        break;
      }
      case "modbus": {
        modbusFrameKey = node.key;
        config = {
          protocol: "modbus" as const,
          register_number: node.metadata?.registerNumber ?? 0,
          device_address: node.metadata?.deviceAddress ?? 1,
          register_type: node.metadata?.registerType ?? "holding",
        };
        break;
      }
      case "serial": {
        config = {
          protocol: "serial" as const,
          frame_id: node.metadata?.frameId ?? node.key,
          delimiter: node.metadata?.delimiter,
        };
        break;
      }
      default:
        return;
    }

    const originalKey = getFrameKeyFromFields({ protocol, config, base: { length: 0 }, modbusFrameKey });

    setFrameFields({
      protocol,
      config,
      base: {
        length: node.metadata?.length ?? (protocol === "can" ? 8 : 1),
        transmitter: node.metadata?.transmitter,
        interval: node.metadata?.interval,
        notes: node.metadata?.notes,
      },
      modbusFrameKey,
      isLengthInherited: node.metadata?.lengthInherited,
      isTransmitterInherited: node.metadata?.transmitterInherited,
      isIntervalInherited: node.metadata?.intervalInherited,
      isDeviceAddressInherited: node.metadata?.deviceAddressInherited,
    });
    setEditingFrameOriginalKey(originalKey);
    setEditingFrame(true);
    setSelectedPath(null);
    clearValidation();
  };

  /**
   * Handle saving a generic frame (CAN, Modbus, or Serial)
   */
  const handleSaveFrame = () => {
    if (!frameFields || !setEditingFrame) return;

    const frameKey = getFrameKeyFromFields(frameFields);
    if (!frameKey) {
      setValidation([{ field: "frame", message: "Frame identifier is required" }]);
      return;
    }

    // Validate protocol-specific config
    const existingKeys = getFrameKeys(catalogContent, frameFields.protocol);
    const configErrors = validateFrameConfig(frameFields.protocol, frameFields.config, {
      existingKeys,
      originalKey: editingFrameOriginalKey ?? undefined,
    });

    // Validate common fields
    const commonErrors = validateCommonFrameFields(
      {
        length: frameFields.base.length,
        transmitter: frameFields.base.transmitter,
        interval: frameFields.base.interval,
      },
      {
        availablePeers,
        maxLength: frameFields.protocol === "can" ? 64 : 256,
      }
    );

    const allErrors = [...configErrors, ...commonErrors];
    if (allErrors.length > 0) {
      setValidation(allErrors);
      return;
    }

    try {
      // For new Modbus frames, create a default signal spanning all registers
      let initialSignals: Array<{ name: string; start_bit: number; bit_length: number; signed?: boolean; endianness?: "big" | "little" }> | undefined;
      if (frameFields.protocol === "modbus" && !editingFrameOriginalKey) {
        const numRegisters = frameFields.base.length || 1;
        const bitLength = numRegisters * 16;
        const signalName = frameFields.modbusFrameKey?.trim() || "value";
        initialSignals = [{
          name: signalName,
          start_bit: 0,
          bit_length: bitLength,
          signed: false,
          endianness: "big",
        }];
      }

      const newContent = upsertFrameToml(catalogContent, {
        protocol: frameFields.protocol,
        base: frameFields.base,
        config: frameFields.config,
        originalKey: editingFrameOriginalKey ?? undefined,
        omitInherited: {
          length: frameFields.isLengthInherited,
          transmitter: frameFields.isTransmitterInherited,
          interval: frameFields.isIntervalInherited,
          deviceAddress: frameFields.isDeviceAddressInherited,
        },
        initialSignals,
      });

      setToml(newContent);
      setEditingFrame(false);
      if (setEditingFrameOriginalKey) setEditingFrameOriginalKey(null);
      clearValidation();
    } catch (error) {
      console.error("Failed to save frame:", error);
      setValidation([{ field: "frame", message: "Failed to save frame" }]);
    }
  };

  /**
   * Handle deleting a frame by protocol and key
   */
  const handleDeleteFrame = (protocol: ProtocolType, key: string) => {
    try {
      const newContent = deleteFrameToml(catalogContent, protocol, key);
      setToml(newContent);
      setSelectedPath(null);
    } catch (error) {
      console.error("Failed to delete frame:", error);
      setValidation([{ field: "frame", message: "Failed to delete frame" }]);
    }
  };

  /**
   * Cancel generic frame editing
   */
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

  const handleConfirmDeleteNode = () => {
    const nodeNameToDelete = dialogPayload.nodeToDelete;
    if (!nodeNameToDelete) return;

    try {
      const newContent = deleteNodeToml(catalogContent, nodeNameToDelete);
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
    openDialog("addNode");
  };

  const handleSaveNode = () => {
    if (!nodeName.trim()) return;

    try {
      const notesToSave = nodeNotes.trim() || undefined;
      const newContent = addNodeToml(catalogContent, nodeName, notesToSave);
      setToml(newContent);
      closeDialog("addNode");
      setNodeName("");
      setNodeNotes("");
    } catch (error) {
      console.error("Failed to add node:", error);
    }
  };

  const handleEditNode = (originalName: string, notes?: string) => {
    setDialogPayload({ editingNodeOriginalName: originalName });
    setNodeName(originalName);
    setNodeNotes(notes || "");
    openDialog("editNode");
  };

  const handleSaveEditNode = () => {
    if (!nodeName.trim()) return;

    const originalName = dialogPayload.editingNodeOriginalName;
    if (!originalName) return;

    try {
      const notesToSave = nodeNotes.trim() || undefined;
      const { toml: newContent, success, error } = editNodeToml(
        catalogContent,
        originalName,
        nodeName,
        notesToSave
      );

      if (!success) {
        setValidation([{ field: "node", message: error || "Failed to edit node" }]);
        return;
      }

      setToml(newContent);
      closeDialog("editNode");
      setNodeName("");
      setNodeNotes("");
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

  const handleConfirmDeleteGeneric = () => {
    const path = dialogPayload.genericPathToDelete;
    if (!path) return;
    try {
      const newContent = deleteTomlAtPath(catalogContent, path);
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

  /**
   * Save unified config - saves meta + only the enabled protocol configs
   * Called from UnifiedConfigDialog with explicit enabled states
   */
  const handleSaveConfig = (enabledConfigs: { can: boolean; serial: boolean; modbus: boolean }) => {
    console.log("[handleSaveConfig] Called with:", enabledConfigs);
    console.log("[handleSaveConfig] catalogContent length:", catalogContent?.length);
    try {
      // Start with updating meta
      let newContent = updateMetaToml(catalogContent, metaFields);
      console.log("[handleSaveConfig] After updateMetaToml, length:", newContent?.length);

      // Save or delete CAN config based on enabled state
      if (enabledConfigs.can) {
        const frameIdMaskStr = canFrameIdMask.trim().replace(/^0x/i, '');
        const frameIdMaskNum = frameIdMaskStr ? parseInt(frameIdMaskStr, 16) : undefined;

        const fields: Record<string, { mask: number; shift?: number; format?: "hex" | "decimal" }> | undefined =
          canHeaderFields.length > 0
            ? Object.fromEntries(
                canHeaderFields
                  .filter((f) => f.name.trim() && f.mask.trim())
                  .map((f) => {
                    const maskStr = f.mask.trim().replace(/^0x/i, '');
                    const maskNum = parseInt(maskStr, 16);
                    return [
                      f.name.trim(),
                      {
                        mask: Number.isFinite(maskNum) ? maskNum : 0,
                        shift: f.shift,
                        format: f.format !== 'hex' ? f.format : undefined,
                      },
                    ];
                  })
              )
            : undefined;

        newContent = upsertCanConfigToml(newContent, {
          default_endianness: canDefaultEndianness,
          default_interval: canDefaultInterval,
          default_extended: canDefaultExtended,
          default_fd: canDefaultFd,
          frame_id_mask: Number.isFinite(frameIdMaskNum) ? frameIdMaskNum : undefined,
          fields,
        });
      } else {
        // Delete CAN config if disabled
        newContent = deleteCanConfigToml(newContent);
      }

      // Save or delete Serial config based on enabled state
      if (enabledConfigs.serial) {
        // Convert header fields to TOML format (mask-based)
        const fields: Record<string, { mask: number; endianness?: "big" | "little"; format?: "hex" | "decimal" }> | undefined =
          serialHeaderFields.length > 0
            ? Object.fromEntries(
                serialHeaderFields
                  .filter((f) => f.name.trim())
                  .map((f) => [
                    f.name.trim(),
                    {
                      mask: f.mask,
                      endianness: f.endianness !== 'big' ? f.endianness : undefined,
                      format: f.format !== 'hex' ? f.format : undefined,
                    },
                  ])
              )
            : undefined;

        newContent = upsertSerialConfigToml(newContent, {
          encoding: serialEncoding,
          byte_order: serialByteOrder,
          header_length: serialHeaderLength,
          max_frame_length: serialMaxFrameLength,
          fields,
          checksum: serialChecksum ?? undefined,
        });
      } else {
        // Delete Serial config if disabled
        newContent = deleteSerialConfigToml(newContent);
      }

      // Save or delete Modbus config based on enabled state
      if (enabledConfigs.modbus) {
        newContent = upsertModbusConfigToml(newContent, {
          device_address: modbusDeviceAddress,
          register_base: modbusRegisterBase,
          default_interval: modbusDefaultInterval,
          default_byte_order: modbusDefaultByteOrder,
          default_word_order: modbusDefaultWordOrder,
        });
      } else {
        // Delete Modbus config if disabled
        newContent = deleteModbusConfigToml(newContent);
      }

      console.log("[handleSaveConfig] Final newContent length:", newContent?.length);
      console.log("[handleSaveConfig] Calling setToml...");
      setToml(newContent);
      console.log("[handleSaveConfig] Calling closeDialog...");
      closeDialog("config");
      clearValidation();
      console.log("[handleSaveConfig] Done!");
    } catch (error) {
      console.error("[handleSaveConfig] Error:", error);
      setValidation([{ field: "config", message: "Failed to save configuration" }]);
    }
  };

  /**
   * Remove CAN config from catalog
   */
  const handleRemoveCanConfig = () => {
    try {
      const newContent = deleteCanConfigToml(catalogContent);
      setToml(newContent);
    } catch (error) {
      console.error("Failed to remove CAN config:", error);
    }
  };

  /**
   * Remove Serial config from catalog
   */
  const handleRemoveSerialConfig = () => {
    try {
      const newContent = deleteSerialConfigToml(catalogContent);
      setToml(newContent);
    } catch (error) {
      console.error("Failed to remove Serial config:", error);
    }
  };

  /**
   * Remove Modbus config from catalog
   */
  const handleRemoveModbusConfig = () => {
    try {
      const newContent = deleteModbusConfigToml(catalogContent);
      setToml(newContent);
    } catch (error) {
      console.error("Failed to remove Modbus config:", error);
    }
  };

  // Legacy individual config handlers (kept for backwards compatibility)
  const handleSaveSerialConfig = () => {
    try {
      // Convert header fields to TOML format (mask-based)
      const fields: Record<string, { mask: number; endianness?: "big" | "little"; format?: "hex" | "decimal" }> | undefined =
        serialHeaderFields.length > 0
          ? Object.fromEntries(
              serialHeaderFields
                .filter((f) => f.name.trim())
                .map((f) => [
                  f.name.trim(),
                  {
                    mask: f.mask,
                    endianness: f.endianness !== 'big' ? f.endianness : undefined,
                    format: f.format !== 'hex' ? f.format : undefined,
                  },
                ])
            )
          : undefined;

      const newContent = upsertSerialConfigToml(catalogContent, {
        encoding: serialEncoding,
        byte_order: serialByteOrder,
        header_length: serialHeaderLength,
        max_frame_length: serialMaxFrameLength,
        fields,
        checksum: serialChecksum ?? undefined,
      });
      setToml(newContent);
      closeDialog("config");
      clearValidation();
    } catch (error) {
      console.error("Failed to save serial config:", error);
      setValidation([{ field: "meta.serial", message: "Failed to save serial configuration" }]);
    }
  };

  const handleSaveModbusConfig = () => {
    try {
      const newContent = upsertModbusConfigToml(catalogContent, {
        device_address: modbusDeviceAddress,
        register_base: modbusRegisterBase,
        default_interval: modbusDefaultInterval,
        default_byte_order: modbusDefaultByteOrder,
        default_word_order: modbusDefaultWordOrder,
      });
      setToml(newContent);
      closeDialog("config");
      clearValidation();
    } catch (error) {
      console.error("Failed to save modbus config:", error);
      setValidation([{ field: "meta.modbus", message: "Failed to save modbus configuration" }]);
    }
  };

  const handleSaveCanConfig = () => {
    try {
      const frameIdMaskStr = canFrameIdMask.trim().replace(/^0x/i, '');
      const frameIdMaskNum = frameIdMaskStr ? parseInt(frameIdMaskStr, 16) : undefined;

      const fields: Record<string, { mask: number; shift?: number; format?: "hex" | "decimal" }> | undefined =
        canHeaderFields.length > 0
          ? Object.fromEntries(
              canHeaderFields
                .filter((f) => f.name.trim() && f.mask.trim())
                .map((f) => {
                  const maskStr = f.mask.trim().replace(/^0x/i, '');
                  const maskNum = parseInt(maskStr, 16);
                  return [
                    f.name.trim(),
                    {
                      mask: Number.isFinite(maskNum) ? maskNum : 0,
                      shift: f.shift,
                      format: f.format !== 'hex' ? f.format : undefined,
                    },
                  ];
                })
            )
          : undefined;

      let newContent = updateMetaToml(catalogContent, metaFields);
      newContent = upsertCanConfigToml(newContent, {
        default_endianness: canDefaultEndianness,
        default_interval: canDefaultInterval,
        default_extended: canDefaultExtended,
        default_fd: canDefaultFd,
        frame_id_mask: Number.isFinite(frameIdMaskNum) ? frameIdMaskNum : undefined,
        fields,
      });
      setToml(newContent);
      closeDialog("config");
      clearValidation();
    } catch (error) {
      console.error("Failed to save CAN config:", error);
      setValidation([{ field: "meta.can", message: "Failed to save CAN configuration" }]);
    }
  };

  return {
    // CAN Frame operations (legacy)
    handleEditId,
    handleSaveId,
    handleDeleteId,
    handleConfirmDeleteId,
    handleAddCanFrame,

    // Generic frame operations
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
    handleRemoveCanConfig,
    handleRemoveSerialConfig,
    handleRemoveModbusConfig,

    // Legacy config operations (kept for backwards compatibility)
    handleSaveSerialConfig,
    handleSaveModbusConfig,
    handleSaveCanConfig,
  };
}
