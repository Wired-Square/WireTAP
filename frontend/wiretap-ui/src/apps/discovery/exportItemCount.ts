import type { ExportDataMode } from "../../dialogs/ExportFramesDialog";
import type { FramingStateMsg } from "../../generated/FramingStateMsg";

export interface ExportCountSources {
  dataMode: ExportDataMode;
  byteCount: number;
  captureMode: { enabled: boolean; totalFrames: number };
  isSerialMode: boolean;
  framing: FramingStateMsg | null;
  liveFrameCount: number;
}

export function exportItemCount(s: ExportCountSources): number {
  if (s.dataMode === "bytes") return s.byteCount;
  if (s.isSerialMode && s.framing && s.framing.frame_count > 0) return s.framing.frame_count;
  if (s.captureMode.enabled) return s.captureMode.totalFrames;
  return s.liveFrameCount;
}
