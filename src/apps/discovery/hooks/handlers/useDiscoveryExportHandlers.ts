// ui/src/apps/discovery/hooks/handlers/useDiscoveryExportHandlers.ts
//
// Export and save handlers for Discovery: export frames, save frames, export formats.

import { useCallback } from "react";
import type { FrameMessage } from "../../../../stores/discoveryStore";
import type { ExportFormat, ExportDataMode } from "../../../../dialogs/ExportFramesDialog";
import type { TimestampedByte } from "../../../../api/buffer";

export interface UseDiscoveryExportHandlersParams {
  // State
  frames: FrameMessage[];
  framedData: FrameMessage[];
  framedBufferId: string | null;
  backendByteCount: number;
  backendFrameCount: number;
  serialBytesBufferLength: number;
  exportDataMode: ExportDataMode;
  bufferModeEnabled: boolean;
  bufferModeTotalFrames: number;
  isSerialMode: boolean;
  decoderDir: string;
  saveFrameIdFormat: 'hex' | 'decimal';
  dumpDir: string;

  // Store actions
  showError: (title: string, message: string, details?: string) => void;
  openSaveDialog: () => void;
  saveFrames: (decoderDir: string, format: 'hex' | 'decimal') => Promise<void>;

  // API functions
  getBufferBytesPaginated: (offset: number, limit: number) => Promise<{ bytes: TimestampedByte[] }>;
  getBufferFramesPaginated: (offset: number, limit: number) => Promise<{ frames: any[] }>;
  getBufferFramesPaginatedById: (id: string, offset: number, limit: number) => Promise<{ frames: any[] }>;
  pickFileToSave: (options: any) => Promise<string | null>;
  saveCatalog: (path: string, content: string) => Promise<void>;

  // Dialog controls
  closeExportDialog: () => void;
}

export function useDiscoveryExportHandlers({
  frames,
  framedData,
  framedBufferId,
  backendByteCount,
  backendFrameCount,
  serialBytesBufferLength: _serialBytesBufferLength,
  exportDataMode,
  bufferModeEnabled,
  bufferModeTotalFrames,
  isSerialMode,
  decoderDir,
  saveFrameIdFormat,
  dumpDir,
  showError,
  openSaveDialog,
  saveFrames,
  getBufferBytesPaginated,
  getBufferFramesPaginated,
  getBufferFramesPaginatedById,
  pickFileToSave,
  saveCatalog,
  closeExportDialog,
}: UseDiscoveryExportHandlersParams) {
  // Handle save frames
  const handleSaveFrames = useCallback(async () => {
    await saveFrames(decoderDir, saveFrameIdFormat);
  }, [saveFrames, decoderDir, saveFrameIdFormat]);

  // Handle export dialog confirm
  const handleExport = useCallback(async (format: ExportFormat, filename: string) => {
    if (!dumpDir) {
      showError("Export Error", "Dump directory not configured", "Please set a dump directory in Settings.");
      return;
    }

    try {
      let content: string | Uint8Array;
      let extension: string;

      if (exportDataMode === "bytes") {
        // Export bytes
        const { exportBytes } = await import("../../../../utils/frameDump");
        let bytesToExport: { byte: number; timestampUs: number }[];

        if (backendByteCount > 0) {
          const response = await getBufferBytesPaginated(0, backendByteCount);
          bytesToExport = response.bytes.map((b: TimestampedByte) => ({
            byte: b.byte,
            timestampUs: b.timestamp_us,
          }));
        } else {
          const { useDiscoverySerialStore } = await import("../../../../stores/discoverySerialStore");
          bytesToExport = useDiscoverySerialStore.getState().serialBytes;
        }

        content = exportBytes(bytesToExport, format);
        extension = format === "hex" ? "hex" : format === "bin" ? "bin" : "csv";
      } else {
        // Export frames
        let framesToExport: FrameMessage[];

        if (bufferModeEnabled) {
          const response = await getBufferFramesPaginated(0, bufferModeTotalFrames);
          framesToExport = response.frames as FrameMessage[];
        } else if (isSerialMode && framedBufferId && backendFrameCount > 0) {
          const response = await getBufferFramesPaginatedById(framedBufferId, 0, backendFrameCount);
          framesToExport = response.frames as FrameMessage[];
        } else if (isSerialMode && framedData.length > 0) {
          framesToExport = framedData;
        } else {
          framesToExport = frames;
        }

        const { exportFrames } = await import("../../../../utils/frameDump");
        content = exportFrames(framesToExport, format);
        extension = format === "csv" ? "csv" : format === "json" ? "json" : "log";
      }

      // Build the full path
      const fullPath = `${dumpDir}/${filename}`;

      // Use pickFileToSave to let user confirm/modify the path
      const selectedPath = await pickFileToSave({
        defaultPath: fullPath,
        filters: [{ name: "Export Files", extensions: [extension] }],
      });

      if (selectedPath) {
        if (content instanceof Uint8Array) {
          // Binary data - convert to string for saving via Tauri command
          const binaryString = Array.from(content).map(b => String.fromCharCode(b)).join('');
          await saveCatalog(selectedPath, binaryString);
        } else {
          await saveCatalog(selectedPath, content);
        }
        closeExportDialog();
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      showError("Export Error", "Failed to export", errorMessage);
    }
  }, [
    dumpDir,
    exportDataMode,
    backendByteCount,
    bufferModeEnabled,
    bufferModeTotalFrames,
    isSerialMode,
    framedBufferId,
    backendFrameCount,
    framedData,
    frames,
    getBufferBytesPaginated,
    getBufferFramesPaginated,
    getBufferFramesPaginatedById,
    pickFileToSave,
    saveCatalog,
    showError,
    closeExportDialog,
  ]);

  return {
    handleSaveFrames,
    handleExport,
    handleOpenSaveDialog: openSaveDialog,
  };
}

export type DiscoveryExportHandlers = ReturnType<typeof useDiscoveryExportHandlers>;
