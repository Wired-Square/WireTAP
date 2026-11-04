// ui/src/api/reports.ts
//
// The export reports, rendered in Rust in the active language: text, Markdown,
// or an HTML body for `reportExport.ts` to theme.

import { invoke } from "@tauri-apps/api/core";
import i18n from "i18next";
import { wsTransport } from "../services/wsTransport";
import type { OrderStart } from "../generated/OrderStart";
import type { ReportLocale } from "../generated/ReportLocale";
import type { AnalysisWindow } from "../stores/discoveryToolboxStore";

export type ReportFormat = "text" | "markdown" | "html";

function flatten(tree: unknown, path: string, out: Record<string, string>) {
  if (typeof tree === "string") out[path] = tree;
  else if (tree && typeof tree === "object") {
    for (const [key, value] of Object.entries(tree)) flatten(value, path.endsWith(":") ? path + key : `${path}.${key}`, out);
  }
}

/** The `reports` namespace and the Changes view's byte notes, with `language`'s number style. */
export function reportLocale(language: string = i18n.language): ReportLocale {
  const messages: Record<string, string> = {};
  flatten(i18n.getResourceBundle(language, "reports"), "reports:", messages);
  flatten(i18n.getResourceBundle(language, "discovery")?.changes, "discovery:changes", messages);
  const parts = new Intl.NumberFormat(language).formatToParts(1234567.8);
  const part = (type: string) => parts.find((p) => p.type === type)?.value;
  return { messages, groupSeparator: part("group") ?? "", decimalSeparator: part("decimal") ?? "." };
}

export async function catalogReport(content: string, format: ReportFormat): Promise<string> {
  return wsTransport.command<string>("catalog.report", { content, format, locale: reportLocale() });
}

export async function payloadChangesReport(window: AnalysisWindow, format: ReportFormat): Promise<string> {
  const { captureId, selection, newest } = window;
  return invoke<string>("payload_changes_report_cmd", {
    capture_id: captureId,
    selection,
    newest,
    format,
    locale: reportLocale(),
  });
}

export async function frameOrderReport(
  window: AnalysisWindow,
  start: OrderStart | null,
  format: ReportFormat,
): Promise<string> {
  const { captureId, selection, newest } = window;
  return invoke<string>("frame_order_report_cmd", {
    capture_id: captureId,
    selection,
    newest,
    start,
    format,
    locale: reportLocale(),
  });
}
