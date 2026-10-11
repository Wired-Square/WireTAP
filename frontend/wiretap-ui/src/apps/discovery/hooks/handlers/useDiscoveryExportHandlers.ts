// ui/src/apps/discovery/hooks/handlers/useDiscoveryExportHandlers.ts
//
// Export and save handlers for Discovery: export frames, save frames, export formats.

import { useCallback } from "react";
import type { FrameMessage } from "../../../../stores/discoveryStore";
import type { ExportFormat, ExportDataMode } from "../../../../dialogs/ExportFramesDialog";
import { exportByteDump, exportFrameDump } from "../../../../api/capture";
import { useSessionStore } from "../../../../stores/sessionStore";
import { withAppError } from "../../../../utils/appError";

export interface UseDiscoveryExportHandlersParams {
  // State
  framedData: FrameMessage[];
  framedCaptureId: string | null;
  activeCaptureId: string | null;
  bytesCaptureId: string | null;
  backendFrameCount: number;
  exportDataMode: ExportDataMode;
  captureModeEnabled: boolean;
  isSerialMode: boolean;
  decoderDir: string;
  saveFrameIdFormat: 'hex' | 'decimal';
  dumpDir: string;

  // Store actions
  openSaveDialog: () => void;
  saveFrames: (decoderDir: string, format: 'hex' | 'decimal') => Promise<void>;

  // API functions
  pickFileToSave: (options: any) => Promise<string | null>;

  // Dialog controls
  closeExportDialog: () => void;
}

export function useDiscoveryExportHandlers({
  framedData,
  framedCaptureId,
  activeCaptureId,
  bytesCaptureId,
  backendFrameCount,
  exportDataMode,
  captureModeEnabled,
  isSerialMode,
  decoderDir,
  saveFrameIdFormat,
  dumpDir,
  openSaveDialog,
  saveFrames,
  pickFileToSave,
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
      const extension =
        exportDataMode === "bytes"
          ? format === "hex" ? "hex" : format === "bin" ? "bin" : "csv"
          : format === "csv" ? "csv" : format === "json" ? "json" : "log";
      const selectedPath = await pickFileToSave({
        defaultPath: `${dumpDir}/${filename}`,
        filters: [{ name: "Export Files", extensions: [extension] }],
      });
      if (!selectedPath) return;

      if (exportDataMode === "bytes") {
        // Bytes live in their own capture, never the session's frames capture.
        if (!bytesCaptureId) return;
        await exportByteDump(bytesCaptureId, format === "hex" || format === "bin" ? format : "csv", selectedPath);
      } else {
        const source =
          captureModeEnabled && activeCaptureId
            ? { captureId: activeCaptureId }
            : isSerialMode && framedCaptureId && backendFrameCount > 0
              ? { captureId: framedCaptureId }
              : isSerialMode && framedData.length > 0
                ? { frames: framedData }
                : activeCaptureId
                  ? { captureId: activeCaptureId }
                  : null;
        if (!source) return;
        await exportFrameDump(source, format === "candump" || format === "json" ? format : "csv", selectedPath);
      }
      closeExportDialog();
    });
  }, [
    dumpDir,
    exportDataMode,
    bytesCaptureId,
    captureModeEnabled,
    isSerialMode,
    framedCaptureId,
    activeCaptureId,
    backendFrameCount,
    framedData,
    pickFileToSave,
    closeExportDialog,
  ]);

  return {
    handleSaveFrames,
    handleExport,
    handleOpenSaveDialog: openSaveDialog,
  };
}

export type DiscoveryExportHandlers = ReturnType<typeof useDiscoveryExportHandlers>;
