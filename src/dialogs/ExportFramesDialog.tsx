// ui/src/dialogs/ExportFramesDialog.tsx

import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import Dialog from "../components/Dialog";
import { Select, FormField, PrimaryButton, SecondaryButton } from "../components/forms";
import { h3, bodyDefault, caption } from "../styles";

export type ExportFormat = "csv" | "json" | "candump" | "hex" | "bin";

/** Data mode for the export dialog */
export type ExportDataMode = "frames" | "bytes";

export type ExportFramesDialogProps = {
  open: boolean;
  /** Number of items to export (frames or bytes depending on mode) */
  itemCount: number;
  /** What kind of data we're exporting */
  dataMode?: ExportDataMode;
  /** Default filename (without extension) - passed to OS file picker */
  defaultFilename?: string;
  onCancel: () => void;
  onExport: (format: ExportFormat, filename: string) => void;
};

const FRAME_FORMAT_EXTENSIONS: Record<string, string> = {
  csv: ".csv",
  json: ".json",
  candump: ".log",
};

const BYTES_FORMAT_EXTENSIONS: Record<string, string> = {
  hex: ".hex",
  bin: ".bin",
  csv: ".csv",
};

export default function ExportFramesDialog({
  open,
  itemCount,
  dataMode = "frames",
  defaultFilename,
  onCancel,
  onExport,
}: ExportFramesDialogProps) {
  const { t } = useTranslation("dialogs");
  const [format, setFormat] = useState<ExportFormat>(dataMode === "bytes" ? "hex" : "csv");

  // Update format when dataMode changes
  useEffect(() => {
    if (dataMode === "bytes") {
      setFormat("hex");
    } else {
      setFormat("csv");
    }
  }, [dataMode]);

  const formatExtensions = dataMode === "bytes" ? BYTES_FORMAT_EXTENSIONS : FRAME_FORMAT_EXTENSIONS;
  const formatOptions = dataMode === "bytes"
    ? [
        { value: "hex" as const, label: t("exportFrames.formats.hex") },
        { value: "bin" as const, label: t("exportFrames.formats.bin") },
        { value: "csv" as const, label: t("exportFrames.formats.csv") },
      ]
    : [
        { value: "csv" as const, label: t("exportFrames.formats.csv") },
        { value: "json" as const, label: t("exportFrames.formats.json") },
        { value: "candump" as const, label: t("exportFrames.formats.candump") },
      ];

  const formatDescription = dataMode === "bytes"
    ? format === "csv" ? t("exportFrames.descriptions.csvBytes") : t(`exportFrames.descriptions.${format}`)
    : t(`exportFrames.descriptions.${format}`);

  const handleExport = () => {
    const ext = formatExtensions[format] || ".txt";
    const baseName = defaultFilename || (dataMode === "bytes" ? "serial-bytes" : "can-frames");
    const fullFilename = `${baseName}${ext}`;
    onExport(format, fullFilename);
  };

  const title = dataMode === "bytes" ? t("exportFrames.titleBytes") : t("exportFrames.titleFrames");
  const summaryKey = dataMode === "bytes" ? "exportFrames.summary_bytes" : "exportFrames.summary_frames";

  return (
    <Dialog isOpen={open} maxWidth="max-w-sm">
      <div className="p-6 space-y-4">
        <div className={h3}>{title}</div>
        <div className={bodyDefault}>{t(summaryKey, { count: itemCount })}</div>

        <FormField label={t("exportFrames.format")} variant="simple">
          <Select
            variant="simple"
            value={format}
            onChange={(e) => setFormat(e.target.value as ExportFormat)}
          >
            {formatOptions.map(opt => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </Select>
        </FormField>

        <div className={caption}>{formatDescription}</div>

        <div className="flex justify-end gap-3 pt-4">
          <SecondaryButton onClick={onCancel}>{t("common:actions.cancel")}</SecondaryButton>
          <PrimaryButton onClick={handleExport}>{t("common:actions.export")}</PrimaryButton>
        </div>
      </div>
    </Dialog>
  );
}
