// ui/src/dialogs/ExportAnalysisDialog.tsx
// Export dialog for Payload Changes analysis - uses shared report utilities

import { useTranslation } from "react-i18next";
import type { ChangesResult } from "../stores/discoveryStore";
import ExportReportDialog from "./ExportReportDialog";
import { generatePayloadChangesReport } from "../utils/payloadChangesReport";
import type { ExportFormat } from "../utils/reportExport";

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

  const handleExport = (format: ExportFormat, filename: string) => {
    const content = generatePayloadChangesReport(results, format);
    onExport(content, filename, format);
  };

  return (
    <ExportReportDialog
      open={open}
      title={t("exportAnalysis.title")}
      description={t("exportAnalysis.description", {
        frameIds: results.uniqueFrameIds,
        samples: results.frameCount.toLocaleString(i18n.language),
      })}
      defaultFilename="payload-analysis-report"
      defaultPath={defaultPath}
      onCancel={onCancel}
      onExport={handleExport}
    />
  );
}
