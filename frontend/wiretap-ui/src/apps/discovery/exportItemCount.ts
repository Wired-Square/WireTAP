import type { ExportDataMode } from "../../dialogs/ExportFramesDialog";

export interface ExportCountSources {
  dataMode: ExportDataMode;
  byteCount: number;
  captureMode: { enabled: boolean; totalFrames: number };
  isSerialMode: boolean;
  framedCaptureId: string | null;
  backendFrameCount: number;
  clientFramedCount: number;
  liveFrameCount: number;
}

export function exportItemCount(s: ExportCountSources): number {
  if (s.dataMode === "bytes") return s.byteCount;
  if (s.isSerialMode && s.framedCaptureId && s.backendFrameCount > 0) return s.backendFrameCount;
  if (s.isSerialMode && s.clientFramedCount > 0) return s.clientFramedCount;
  if (s.captureMode.enabled) return s.captureMode.totalFrames;
  return s.liveFrameCount;
}
