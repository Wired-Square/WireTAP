// ui/src/api/reports.ts
//
// The export reports, rendered in Rust: text, Markdown, or an HTML body for
// `reportExport.ts` to theme.

import { invoke } from "@tauri-apps/api/core";
import { wsTransport } from "../services/wsTransport";
import type { OrderStart } from "../generated/OrderStart";
import type { AnalysisWindow } from "../stores/discoveryToolboxStore";

export type ReportFormat = "text" | "markdown" | "html";

export async function catalogReport(content: string, format: ReportFormat): Promise<string> {
  return wsTransport.command<string>("catalog.report", { content, format });
}

export async function payloadChangesReport(window: AnalysisWindow, format: ReportFormat): Promise<string> {
  const { captureId, selection, newest } = window;
  return invoke<string>("payload_changes_report_cmd", { capture_id: captureId, selection, newest, format });
}

export async function frameOrderReport(
  window: AnalysisWindow,
  start: OrderStart | null,
  format: ReportFormat,
): Promise<string> {
  const { captureId, selection, newest } = window;
  return invoke<string>("frame_order_report_cmd", { capture_id: captureId, selection, newest, start, format });
}
