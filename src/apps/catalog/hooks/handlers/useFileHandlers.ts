// ui/src/apps/catalog/hooks/handlers/useFileHandlers.ts
// File I/O operations for catalog editor

import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { useCatalogEditorStore } from "../../../../stores/catalogEditorStore";
import { openCatalogAtPath, saveCatalogAtPath, pickCatalogToOpen, pickCatalogSavePath } from "../../io";
import { parseTomlToTree } from "../../toml";
import {
  createMinimalCatalogToml,
  upsertSerialConfigToml,
  upsertModbusConfigToml,
  upsertCanConfigToml,
} from "../../editorOps";
import { validateMetaFields, validateCatalog, validateSerialConfig } from "../../validate";
import type { AppSettings } from "../../../../hooks/useSettings";
import type { ProtocolType } from "../../types";


export interface UseFileHandlersParams {
  settings: AppSettings | null | undefined;
  saveFrameIdFormat: "hex" | "decimal";
}

export function useFileHandlers({ settings, saveFrameIdFormat }: UseFileHandlersParams) {
  // Store selectors
  const catalogPath = useCatalogEditorStore((s) => s.file.path);
  const decoderDir = useCatalogEditorStore((s) => s.file.decoderDir);
  const hasUnsavedChanges = useCatalogEditorStore((s) => s.hasUnsavedChanges);
  const setDecoderDir = useCatalogEditorStore((s) => s.setDecoderDir);
  const openSuccess = useCatalogEditorStore((s) => s.openSuccess);

  const catalogContent = useCatalogEditorStore((s) => s.content.toml);
  const saveSuccess = useCatalogEditorStore((s) => s.saveSuccess);

  const metaFields = useCatalogEditorStore((s) => s.forms.meta);
  const setMetaFields = useCatalogEditorStore((s) => s.setMetaForm);

  // Protocol config fields from store
  const serialEncoding = useCatalogEditorStore((s) => s.forms.serialEncoding);
  const modbusDeviceAddress = useCatalogEditorStore((s) => s.forms.modbusDeviceAddress);
  const modbusRegisterBase = useCatalogEditorStore((s) => s.forms.modbusRegisterBase);
  const canDefaultEndianness = useCatalogEditorStore((s) => s.forms.canDefaultEndianness);
  const canDefaultInterval = useCatalogEditorStore((s) => s.forms.canDefaultInterval);
  const canDefaultExtended = useCatalogEditorStore((s) => s.forms.canDefaultExtended);
  const canDefaultFd = useCatalogEditorStore((s) => s.forms.canDefaultFd);

  const openDialog = useCatalogEditorStore((s) => s.openDialog);
  const closeDialog = useCatalogEditorStore((s) => s.closeDialog);
  const setValidation = useCatalogEditorStore((s) => s.setValidation);
  const clearValidation = useCatalogEditorStore((s) => s.clearValidation);
  const saveStart = useCatalogEditorStore((s) => s.saveStart);
  const saveError = useCatalogEditorStore((s) => s.saveError);

  // File operations
  const loadDefaultCatalog = async () => {
    if (!settings) return;
    setDecoderDir(settings.decoder_dir);
  };

  const handleNewCatalog = () => {
    setMetaFields({
      name: "",
      version: 1,
    });
    openDialog("newCatalog");
  };

  /**
   * Create a new catalog with the selected protocol config
   * @param selectedProtocol - The protocol type selected in NewCatalogDialog
   */
  const handleCreateNewCatalog = async (selectedProtocol: ProtocolType) => {
    const errors = validateMetaFields(metaFields);
    if (errors.length > 0) {
      setValidation(errors);
      return;
    }

    try {
      let content = createMinimalCatalogToml(metaFields);

      // Add protocol config based on selection
      if (selectedProtocol === "can") {
        content = upsertCanConfigToml(content, {
          default_endianness: canDefaultEndianness,
          default_interval: canDefaultInterval,
          default_extended: canDefaultExtended,
          default_fd: canDefaultFd,
        });
      } else if (selectedProtocol === "modbus") {
        content = upsertModbusConfigToml(content, {
          device_address: modbusDeviceAddress,
          register_base: modbusRegisterBase,
        });
      } else if (selectedProtocol === "serial") {
        content = upsertSerialConfigToml(content, { encoding: serialEncoding });
      }

      const nameBase = metaFields.name.trim() || "decoder";
      const numericName = /^\d+$/.test(nameBase) ? parseInt(nameBase, 10) : null;
      const formattedName =
        numericName !== null
          ? saveFrameIdFormat === "hex"
            ? `0x${numericName.toString(16)}`
            : `${numericName}`
          : nameBase.toLowerCase().replace(/\s+/g, "-");
      const defaultPath =
        decoderDir && formattedName ? `${decoderDir}/${formattedName}.toml` : undefined;
      const savePath = await pickCatalogSavePath(defaultPath);
      if (savePath) {
        await saveCatalogAtPath(savePath, content);
        openSuccess(savePath, content);
        clearValidation();
        closeDialog("newCatalog");
      }
    } catch (error) {
      console.error("Failed to create new catalog:", error);
      setValidation([{ field: "meta", message: "Failed to create catalog" }]);
    }
  };

  const handleOpenFile = async () => {
    try {
      const selected = await pickCatalogToOpen(decoderDir || undefined);

      if (selected) {
        const content = await openCatalogAtPath(selected);
        openSuccess(selected, content);
      }
    } catch (error) {
      console.error("Failed to open catalog:", error);
    }
  };

  const handleReload = async () => {
    if (!catalogPath) return;

    // Warn if there are unsaved changes
    const hasUnsaved = hasUnsavedChanges();
    if (hasUnsaved) {
      const confirmed = window.confirm(
        "You have unsaved changes. Reload will discard them. Continue?"
      );
      if (!confirmed) return;
    }

    try {
      const content = await openCatalogAtPath(catalogPath);
      openSuccess(catalogPath, content);
    } catch (error) {
      console.error("Failed to reload catalog:", error);
    }
  };

  const handleSave = async () => {
    if (!catalogPath) return;

    saveStart();
    try {
      await saveCatalogAtPath(catalogPath, catalogContent);
      saveSuccess(catalogContent);
      console.log("Catalog saved successfully");
    } catch (error) {
      console.error("Failed to save catalog:", error);
      saveError(String(error));
    }
  };

  const handleValidate = async () => {
    if (!catalogContent) return;

    try {
      // Run backend validation
      const result = await validateCatalog(catalogContent);
      const allErrors = [...result.errors];

      // Also run frontend serial config validation
      try {
        const parsed = parseTomlToTree(catalogContent);
        // Check if there are any serial frames (any child of frame.serial that isn't 'config')
        const hasSerialFrames = parsed.tree.some(
          (node) =>
            node.path.length >= 3 &&
            node.path[0] === "frame" &&
            node.path[1] === "serial" &&
            node.path[2] !== "config"
        );
        const serialErrors = validateSerialConfig(hasSerialFrames, parsed.serialConfig);
        allErrors.push(...serialErrors);
      } catch (parseError) {
        // If parsing fails, the backend validation should have caught it
        console.warn("Failed to parse catalog for serial config validation:", parseError);
      }

      const isValid = allErrors.length === 0;
      setValidation(allErrors, isValid);
      openDialog("validationErrors");
    } catch (error) {
      console.error("Validation failed:", error);
      setValidation([{ field: "validation", message: String(error) }], false);
      openDialog("validationErrors");
    }
  };

  // Unsaved changes dialog
  const handleConfirmLeave = () => {
    closeDialog("unsavedChanges");
    getCurrentWebviewWindow().close();
  };

  const handleCancelLeave = () => {
    closeDialog("unsavedChanges");
  };

  return {
    loadDefaultCatalog,
    handleNewCatalog,
    handleCreateNewCatalog,
    handleOpenFile,
    handleReload,
    handleSave,
    handleValidate,
    handleConfirmLeave,
    handleCancelLeave,
  };
}
