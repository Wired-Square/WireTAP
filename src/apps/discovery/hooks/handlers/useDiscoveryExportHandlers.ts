// ui/src/apps/discovery/hooks/handlers/useDiscoveryExportHandlers.ts
//
// Export and save handlers for Discovery: export frames, save frames, export formats.

import { useCallback } from "react";
import type { FrameMessage } from "../../../../stores/discoveryStore";
import type { ExportFormat, ExportDataMode } from "../../../../dialogs/ExportFramesDialog";
import type { TimestampedByte } from "../../../../api/capture";
import { useSessionStore } from "../../../../stores/sessionStore";
import { withAppError } from "../../../../utils/appError";

export interface UseDiscoveryExportHandlersParams {
  // State
  frames: FrameMessage[];
  framedData: FrameMessage[];
  framedCaptureId: string | null;
  backendByteCount: number;
  backendFrameCount: number;
  serialBytesBufferLength: number;
  exportDataMode: ExportDataMode;
  captureModeEnabled: boolean;
  captureModeTotalFrames: number;
  isSerialMode: boolean;
  decoderDir: string;
  saveFrameIdFormat: 'hex' | 'decimal';
  dumpDir: string;

  // Store actions
  openSaveDialog: () => void;
  saveFrames: (decoderDir: string, format: 'hex' | 'decimal') => Promise<void>;

  // API functions
  getCaptureBytesPaginated: (offset: number, limit: number) => Promise<{ bytes: TimestampedByte[] }>;
  getCaptureFramesPaginated: (offset: number, limit: number) => Promise<{ frames: any[] }>;
  getCaptureFramesPaginatedById: (id: string, offset: number, limit: number) => Promise<{ frames: any[] }>;
  pickFileToSave: (options: any) => Promise<string | null>;
  saveCatalog: (path: string, content: string) => Promise<void>;

  // Dialog controls
  closeExportDialog: () => void;
}

export function useDiscoveryExportHandlers({
  frames,
  framedData,
  framedCaptureId,
  backendByteCount,
  backendFrameCount,
  serialBytesBufferLength: _serialBytesBufferLength,
  exportDataMode,
  captureModeEnabled,
  captureModeTotalFrames,
  isSerialMode,
  decoderDir,
  saveFrameIdFormat,
  dumpDir,
  openSaveDialog,
  saveFrames,
  getCaptureBytesPaginated,
  getCaptureFramesPaginated,
  getCaptureFramesPaginatedById,
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
      useSessionStore.getState().showAppError("Export Error", "Dump directory not configured", "Please set a dump directory in Settings.");
      return;
    }

    await withAppError("Export Error", "Failed to export", async () => {
      let content: string | Uint8Array;
      let extension: string;

      if (exportDataMode === "bytes") {
        // Export bytes
        const { exportBytes } = await import("../../../../utils/frameDump");
        let bytesToExport: { byte: number; timestampUs: number }[];

        if (backendByteCount > 0) {
          const response = await getCaptureBytesPaginated(0, backendByteCount);
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

        if (captureModeEnabled) {
          const response = await getCaptureFramesPaginated(0, captureModeTotalFrames);
          framesToExport = response.frames as FrameMessage[];
        } else if (isSerialMode && framedCaptureId && backendFrameCount > 0) {
          const response = await getCaptureFramesPaginatedById(framedCaptureId, 0, backendFrameCount);
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
    });
  }, [
    dumpDir,
    exportDataMode,
    backendByteCount,
    captureModeEnabled,
    captureModeTotalFrames,
    isSerialMode,
    framedCaptureId,
    backendFrameCount,
    framedData,
    frames,
    getCaptureBytesPaginated,
    getCaptureFramesPaginated,
    getCaptureFramesPaginatedById,
    pickFileToSave,
    saveCatalog,
    closeExportDialog,
  ]);

  return {
    handleSaveFrames,
    handleExport,
    handleOpenSaveDialog: openSaveDialog,
  };
}

export type DiscoveryExportHandlers = ReturnType<typeof useDiscoveryExportHandlers>;
