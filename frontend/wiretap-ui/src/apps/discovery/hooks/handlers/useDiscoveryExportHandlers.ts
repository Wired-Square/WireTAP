// ui/src/apps/discovery/hooks/handlers/useDiscoveryExportHandlers.ts
//
// Export and save handlers for Discovery: export frames, save frames, export formats.

import { useCallback } from "react";
import type { FrameMessage } from "../../../../stores/discoveryStore";
import type { ExportFormat, ExportDataMode } from "../../../../dialogs/ExportFramesDialog";
import { exportFrameDump, type TimestampedByte } from "../../../../api/capture";
import { useSessionStore } from "../../../../stores/sessionStore";
import { withAppError } from "../../../../utils/appError";

export interface UseDiscoveryExportHandlersParams {
  // State
  liveFrameCount: number;
  framedData: FrameMessage[];
  framedCaptureId: string | null;
  activeCaptureId: string | null;
  backendByteCount: number;
  backendFrameCount: number;
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
  getCaptureFramesPaginatedById: (id: string, offset: number, limit: number) => Promise<{ frames: any[] }>;
  pickFileToSave: (options: any) => Promise<string | null>;
  saveCatalog: (path: string, content: string) => Promise<void>;

  // Dialog controls
  closeExportDialog: () => void;
}

export function useDiscoveryExportHandlers({
  liveFrameCount,
  framedData,
  framedCaptureId,
  activeCaptureId,
  backendByteCount,
  backendFrameCount,
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
        const { exportBytes } = await import("../../../../utils/frameDump");
        const response = await getCaptureBytesPaginated(0, backendByteCount);
        const content = exportBytes(
          response.bytes.map((b: TimestampedByte) => ({ byte: b.byte, timestampUs: b.timestamp_us })),
          format,
        );
        await saveCatalog(
          selectedPath,
          content instanceof Uint8Array ? Array.from(content, (b) => String.fromCharCode(b)).join("") : content,
        );
      } else {
        const capture = (captureId: string, count: number) => ({ captureId, count });
        const source =
          captureModeEnabled && activeCaptureId
            ? capture(activeCaptureId, captureModeTotalFrames)
            : isSerialMode && framedCaptureId && backendFrameCount > 0
              ? capture(framedCaptureId, backendFrameCount)
              : isSerialMode && framedData.length > 0
                ? { frames: framedData }
                : activeCaptureId
                  ? capture(activeCaptureId, liveFrameCount)
                  : null;
        if (!source) return;

        if (format === "csv" || format === "candump") {
          await exportFrameDump(source, format, selectedPath);
        } else {
          const framesToExport =
            "frames" in source
              ? source.frames
              : (await getCaptureFramesPaginatedById(source.captureId, 0, source.count)).frames;
          const { exportToJson } = await import("../../../../utils/frameDump");
          await saveCatalog(selectedPath, exportToJson(framesToExport));
        }
      }
      closeExportDialog();
    });
  }, [
    dumpDir,
    exportDataMode,
    backendByteCount,
    captureModeEnabled,
    captureModeTotalFrames,
    isSerialMode,
    framedCaptureId,
    activeCaptureId,
    backendFrameCount,
    framedData,
    liveFrameCount,
    getCaptureBytesPaginated,
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
