// ui/src/apps/catalog/dialogs/ExportCatalogDialog.tsx

import { useState } from "react";
import { Download, FileText, Database, FileCode, BookOpen } from "lucide-react";
import { iconMd, iconLg } from "../../../styles/spacing";
import { caption, sectionHeaderText } from "../../../styles/typography";
import { selectableOptionBox } from "../../../styles/cardStyles";
import { secondaryButton, disabledState } from "../../../styles";
import Dialog from "../../../components/Dialog";
import { pickFileToSave, CATALOG_FILTERS, DBC_FILTERS, HTML_FILTERS, MARKDOWN_FILTERS, TEXT_FILTERS, type DialogFilter } from "../../../api/dialogs";
import { exportCatalog, saveCatalog, type DbcMuxMode } from "../../../api/catalog";
import { tomlParse } from "../toml";
import { generateCatalogReport, type CatalogReportFormat } from "../../../utils/catalogReport";
import { useSettings } from "../../../hooks/useSettings";
import type { CatalogDoc } from "../../../types/catalog";

export type CatalogExportFormat = "toml" | "dbc" | "html-screen" | "html-print" | "markdown" | "text";

export type ExportCatalogDialogProps = {
  open: boolean;
  catalogContent: string;
  currentFilename: string;
  onCancel: () => void;
  onExportComplete: () => void;
};

interface FormatInfo {
  name: string;
  description: string;
  icon: typeof FileText;
  extension: string;
  filters: DialogFilter[];
  group: "data" | "report";
}

const FORMAT_INFO: Record<CatalogExportFormat, FormatInfo> = {
  toml: {
    name: "TOML Catalog",
    description: "Native CANdor format. Preserves all features including nested multiplexing, confidence levels, and decode sets.",
    icon: FileText,
    extension: ".toml",
    filters: CATALOG_FILTERS,
    group: "data",
  },
  dbc: {
    name: "DBC (Vector CANdb++)",
    description: "Industry-standard format for CAN database files.",
    icon: Database,
    extension: ".dbc",
    filters: DBC_FILTERS,
    group: "data",
  },
  "html-screen": {
    name: "HTML Report (Screen)",
    description: "Rich HTML with dark theme colors and styling. Best for viewing on screen.",
    icon: FileCode,
    extension: ".html",
    filters: HTML_FILTERS,
    group: "report",
  },
  "html-print": {
    name: "HTML Report (Print)",
    description: "Light theme HTML optimized for printing or PDF export via browser print.",
    icon: FileCode,
    extension: ".html",
    filters: HTML_FILTERS,
    group: "report",
  },
  markdown: {
    name: "Markdown Report",
    description: "Structured markdown with tables and sections. Compatible with documentation tools.",
    icon: BookOpen,
    extension: ".md",
    filters: MARKDOWN_FILTERS,
    group: "report",
  },
  text: {
    name: "Text Report",
    description: "Plain text report with visual formatting. Works anywhere.",
    icon: FileText,
    extension: ".txt",
    filters: TEXT_FILTERS,
    group: "report",
  },
};

const FORMAT_OPTIONS: { value: CatalogExportFormat; label: string }[] = [
  { value: "toml", label: "TOML Catalog (.toml)" },
  { value: "dbc", label: "DBC File (.dbc)" },
  { value: "html-screen", label: "HTML Report - Screen (.html)" },
  { value: "html-print", label: "HTML Report - Print (.html)" },
  { value: "markdown", label: "Markdown Report (.md)" },
  { value: "text", label: "Text Report (.txt)" },
];

export default function ExportCatalogDialog({
  open,
  catalogContent,
  currentFilename,
  onCancel,
  onExportComplete,
}: ExportCatalogDialogProps) {
  const [format, setFormat] = useState<CatalogExportFormat>("toml");
  const [dbcMuxMode, setDbcMuxMode] = useState<DbcMuxMode>("extended");
  const [isExporting, setIsExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { settings } = useSettings();

  const handleExport = async () => {
    setError(null);
    setIsExporting(true);

    try {
      const formatInfo = FORMAT_INFO[format];
      const baseName = currentFilename.replace(/\.[^/.]+$/, "") || "catalog";
      const defaultFilename = `${baseName}${formatInfo.extension}`;

      // Use report_dir for report formats, just filename for data formats
      const defaultPath = formatInfo.group === "report" && settings?.report_dir
        ? `${settings.report_dir}/${defaultFilename}`
        : defaultFilename;

      // Pick save location
      const path = await pickFileToSave({
        defaultPath,
        filters: formatInfo.filters,
      });

      if (!path) {
        setIsExporting(false);
        return; // User cancelled
      }

      if (formatInfo.group === "data") {
        // Export as data format (TOML or DBC) - uses Rust backend
        const muxMode = format === "dbc" ? dbcMuxMode : undefined;
        await exportCatalog(path, catalogContent, format as "toml" | "dbc", muxMode);
      } else {
        // Generate report - parse TOML and generate report content
        const catalogDoc = tomlParse(catalogContent) as CatalogDoc;
        const reportFormat = format as CatalogReportFormat;
        const content = generateCatalogReport(catalogDoc, reportFormat);
        await saveCatalog(path, content);
      }

      onExportComplete();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsExporting(false);
    }
  };

  if (!open) return null;

  const formatInfo = FORMAT_INFO[format];
  const FormatIcon = formatInfo.icon;

  return (
    <Dialog isOpen={open} maxWidth="max-w-md" onBackdropClick={onCancel}>
      <div className="p-6">
        <div className="flex items-center gap-3 mb-4">
          <div className="p-2 bg-[var(--bg-orange)] rounded-lg">
            <Download className={`${iconLg} text-[color:var(--text-orange)]`} />
          </div>
          <h2 className="text-xl font-bold text-[color:var(--text-primary)]">
            Export Catalog
          </h2>
        </div>

        <div className="space-y-4">
          <div>
            <label className={`block ${sectionHeaderText} mb-2`}>
              Export Format
            </label>
            <select
              value={format}
              onChange={(e) => {
                setFormat(e.target.value as CatalogExportFormat);
                setError(null);
              }}
              className="w-full px-4 py-2 rounded-lg border border-[color:var(--border-default)] bg-[var(--bg-surface)] text-[color:var(--text-primary)]"
            >
              <optgroup label="Data Formats">
                {FORMAT_OPTIONS.filter(o => FORMAT_INFO[o.value].group === "data").map(opt => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </optgroup>
              <optgroup label="Documentation Reports">
                {FORMAT_OPTIONS.filter(o => FORMAT_INFO[o.value].group === "report").map(opt => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </optgroup>
            </select>
          </div>

          <div className="p-4 bg-[var(--bg-surface)] rounded-lg">
            <div className="flex items-start gap-3">
              <FormatIcon className={`${iconLg} text-[color:var(--text-muted)] mt-0.5`} />
              <div>
                <div className="font-medium text-[color:var(--text-primary)]">
                  {formatInfo.name}
                </div>
                <div className="text-sm text-[color:var(--text-muted)] mt-1">
                  {formatInfo.description}
                </div>
              </div>
            </div>
          </div>

          {format === "dbc" && (
            <div>
              <label className={`block ${sectionHeaderText} mb-2`}>
                Multiplexing Mode
              </label>
              <div className="space-y-2">
                <label className={selectableOptionBox}>
                  <input
                    type="radio"
                    name="dbcMuxMode"
                    value="extended"
                    checked={dbcMuxMode === "extended"}
                    onChange={(e) => setDbcMuxMode(e.target.value as DbcMuxMode)}
                    className="mt-0.5 w-4 h-4 text-orange-600 border-[color:var(--border-default)] focus:ring-orange-500"
                  />
                  <div>
                    <div className="font-medium text-[color:var(--text-primary)] text-sm">
                      Extended (SG_MUL_VAL_)
                    </div>
                    <div className={`${caption} mt-0.5`}>
                      Uses SG_MUL_VAL_ section with mNM notation for nested multiplexors. Best for modern tools.
                    </div>
                  </div>
                </label>
                <label className={selectableOptionBox}>
                  <input
                    type="radio"
                    name="dbcMuxMode"
                    value="flattened"
                    checked={dbcMuxMode === "flattened"}
                    onChange={(e) => setDbcMuxMode(e.target.value as DbcMuxMode)}
                    className="mt-0.5 w-4 h-4 text-orange-600 border-[color:var(--border-default)] focus:ring-orange-500"
                  />
                  <div>
                    <div className="font-medium text-[color:var(--text-primary)] text-sm">
                      Flattened (Legacy)
                    </div>
                    <div className={`${caption} mt-0.5`}>
                      Flattens nested mux into composite values. Compatible with older tools.
                    </div>
                  </div>
                </label>
              </div>
            </div>
          )}

          {error && (
            <div className="p-3 bg-[var(--bg-red)] border border-[color:var(--border-red)] rounded-lg text-sm text-[color:var(--text-red)]">
              {error}
            </div>
          )}
        </div>

        <div className="flex justify-end gap-3 mt-6">
          <button
            onClick={onCancel}
            disabled={isExporting}
            className={`${secondaryButton} ${disabledState}`}
          >
            Cancel
          </button>
          <button
            onClick={handleExport}
            disabled={isExporting}
            className="flex items-center gap-2 px-6 py-2 rounded-lg bg-orange-600 text-white hover:bg-orange-700 transition-colors disabled:opacity-50"
          >
            {isExporting ? (
              <>
                <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                Saving...
              </>
            ) : (
              <>
                <Download className={iconMd} />
                Save As...
              </>
            )}
          </button>
        </div>
      </div>
    </Dialog>
  );
}
