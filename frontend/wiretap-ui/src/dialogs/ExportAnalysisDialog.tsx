// ui/src/dialogs/ExportAnalysisDialog.tsx
// Export dialog for Payload Changes analysis - uses shared report utilities

import { useTranslation } from "react-i18next";
import type { ChangesResult } from "../stores/discoveryStore";
import ExportReportDialog from "./ExportReportDialog";
import { payloadChangesReport } from "../api/reports";
import { renderReport, type ExportFormat } from "../utils/reportExport";
import { withAppError } from "../utils/appError";

export type ExportAnalysisDialogProps = {
  open: boolean;
  results: ChangesResult | null;
  defaultPath?: string;
  onCancel: () => void;
  onExport: (content: string, filename: string, format: ExportFormat) => void;
};

export default function ExportAnalysisDialog({
  open,
  results,
  defaultPath,
  onCancel,
  onExport,
}: ExportAnalysisDialogProps) {
  const { t, i18n } = useTranslation("dialogs");
  if (!results) return null;

  const handleExport = (format: ExportFormat, filename: string) =>
    withAppError("Export Error", "The report was not exported", async () => {
      const content = format === "json"
        ? JSON.stringify(results, null, 2)
        : await renderReport(format, "Payload Changes Report", (f) => payloadChangesReport(results.window, f));
      onExport(content, filename, format);
    });

  return (
    <ExportReportDialog
      open={open}
      title={t("exportAnalysis.title")}
      description={t("exportAnalysis.description", {
        frameIds: results.frames.length,
        samples: results.frameCount.toLocaleString(i18n.language),
      })}
      defaultFilename="payload-analysis-report"
      defaultPath={defaultPath}
      onCancel={onCancel}
      onExport={handleExport}
    />
  );
}
