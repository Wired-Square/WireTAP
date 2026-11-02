import type { ExportDataMode } from "../../dialogs/ExportFramesDialog";

export function exportProtocol(dataMode: ExportDataMode, framedProtocol: string | undefined, frameProtocol: string | undefined): string | undefined {
  return dataMode === "bytes" ? "serial" : framedProtocol ?? frameProtocol;
}
