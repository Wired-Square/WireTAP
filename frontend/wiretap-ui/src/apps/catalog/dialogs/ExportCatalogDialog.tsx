// ui/src/apps/catalog/dialogs/ExportCatalogDialog.tsx

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Download, FileText, Database, FileCode, BookOpen } from "lucide-react";
import { iconMd, iconLg } from "../../../styles/spacing";
import { caption, sectionHeaderText } from "../../../styles/typography";
import { cardClass } from "../../../components/Card";
import Dialog, { DialogBody, DialogFooter } from "../../../components/Dialog";
import { pickFileToSave, CATALOG_FILTERS, DBC_FILTERS, HTML_FILTERS, MARKDOWN_FILTERS, TEXT_FILTERS, type DialogFilter } from "../../../api/dialogs";
import { exportDbcWs, saveCatalog, type DbcMuxMode } from "../../../api/catalog";
import { catalogReport } from "../../../api/reports";
import { renderReport } from "../../../utils/reportExport";
import { useSettings } from "../../../hooks/useSettings";
import { Button } from "../../../components/Button";
import { SecondaryButton, Select, Radio } from "../../../components/forms";

export type CatalogExportFormat = "toml" | "dbc" | "html-screen" | "html-print" | "markdown" | "text";

export type ExportCatalogDialogProps = {
  open: boolean;
  catalogContent: string;
  currentFilename: string;
  onCancel: () => void;
  onExportComplete: () => void;
};

interface FormatInfo {
  icon: typeof FileText;
  extension: string;
  filters: DialogFilter[];
  group: "data" | "report";
}

const FORMAT_INFO: Record<CatalogExportFormat, FormatInfo> = {
  toml: {
    icon: FileText,
    extension: ".toml",
    filters: CATALOG_FILTERS,
    group: "data",
  },
  dbc: {
    icon: Database,
    extension: ".dbc",
    filters: DBC_FILTERS,
    group: "data",
  },
  "html-screen": {
    icon: FileCode,
    extension: ".html",
    filters: HTML_FILTERS,
    group: "report",
  },
  "html-print": {
    icon: FileCode,
    extension: ".html",
    filters: HTML_FILTERS,
    group: "report",
  },
  markdown: {
    icon: BookOpen,
    extension: ".md",
    filters: MARKDOWN_FILTERS,
    group: "report",
  },
  text: {
    icon: FileText,
    extension: ".txt",
    filters: TEXT_FILTERS,
    group: "report",
  },
};

const FORMATS = Object.keys(FORMAT_INFO) as CatalogExportFormat[];

const optionCard = cardClass({ interactive: true }, "flex items-start gap-3");


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
  const { t } = useTranslation("catalog");

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
        // Export as data format. TOML is the catalogue as-is; DBC is rendered by
        // the shared wslib-wiretap-catalogue crate over the WebSocket.
        const output = format === "dbc"
          ? await exportDbcWs(catalogContent, "WireTAP", dbcMuxMode)
          : catalogContent;
        await saveCatalog(path, output);
      } else {
        const content = await renderReport(format as Exclude<CatalogExportFormat, "toml" | "dbc">, t("reports:catalogue.title", { name: baseName }), (f) =>
          catalogReport(catalogContent, f),
        );
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
    <Dialog
      isOpen={open}
      onClose={onCancel}
      title={t("exportDialog.title")}
      icon={<Download className="text-orange" />}
    >
      <DialogBody className="space-y-4">
        <div>
          <label className={`block ${sectionHeaderText} mb-2`}>
            {t("exportDialog.format")}
          </label>
          <Select
            value={format}
            onChange={(e) => {
              setFormat(e.target.value as CatalogExportFormat);
              setError(null);
            }}
            size="lg"
          >
            {(["data", "report"] as const).map((group) => (
              <optgroup key={group} label={t(`exportDialog.groups.${group}`)}>
                {FORMATS.filter((f) => FORMAT_INFO[f].group === group).map((f) => (
                  <option key={f} value={f}>{t(`exportDialog.formats.${f}.option`)}</option>
                ))}
              </optgroup>
            ))}
          </Select>
        </div>

        <div className="p-4 bg-surface rounded-lg">
          <div className="flex items-start gap-3">
            <FormatIcon className={`${iconLg} text-muted mt-0.5`} />
            <div>
              <div className="font-medium text-primary">
                {t(`exportDialog.formats.${format}.name`)}
              </div>
              <div className="text-sm text-muted mt-1">
                {t(`exportDialog.formats.${format}.description`)}
              </div>
            </div>
          </div>
        </div>

        {format === "dbc" && (
          <div>
            <label className={`block ${sectionHeaderText} mb-2`}>
              {t("exportDialog.muxMode")}
            </label>
            <div className="space-y-2">
              <label className={optionCard}>
                <Radio
                  name="dbcMuxMode"
                  value="extended"
                  checked={dbcMuxMode === "extended"}
                  onChange={(e) => setDbcMuxMode(e.target.value as DbcMuxMode)}
                  className="mt-0.5"
                />
                <div>
                  <div className="font-medium text-primary text-sm">
                    {t("exportDialog.muxExtended")}
                  </div>
                  <div className={`${caption} mt-0.5`}>
                    {t("exportDialog.muxExtendedHint")}
                  </div>
                </div>
              </label>
              <label className={optionCard}>
                <Radio
                  name="dbcMuxMode"
                  value="flattened"
                  checked={dbcMuxMode === "flattened"}
                  onChange={(e) => setDbcMuxMode(e.target.value as DbcMuxMode)}
                  className="mt-0.5"
                />
                <div>
                  <div className="font-medium text-primary text-sm">
                    {t("exportDialog.muxFlattened")}
                  </div>
                  <div className={`${caption} mt-0.5`}>
                    {t("exportDialog.muxFlattenedHint")}
                  </div>
                </div>
              </label>
            </div>
          </div>
        )}

        {error && (
          <div className="p-3 bg-danger border border-danger rounded-lg text-sm text-red">
            {error}
          </div>
        )}
      </DialogBody>
      <DialogFooter>
        <SecondaryButton
          onClick={onCancel}
          disabled={isExporting}
        >
          {t("common:actions.cancel")}
        </SecondaryButton>
        <Button
          onClick={handleExport}
          disabled={isExporting}
          variant="solid"
          tone="warning"
          size="lg"
        >
          {isExporting ? (
            <>
              <div className="w-4 h-4 border-2 border-current/30 border-t-current rounded-full animate-spin" />
              {t("exportDialog.saving")}
            </>
          ) : (
            <>
              <Download className={iconMd} />
              {t("exportDialog.saveAs")}
            </>
          )}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
