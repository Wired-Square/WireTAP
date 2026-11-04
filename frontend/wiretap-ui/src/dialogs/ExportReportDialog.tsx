// ui/src/dialogs/ExportReportDialog.tsx
// Generic export dialog for analysis reports

import { useState } from "react";
import { useTranslation } from "react-i18next";
import Dialog, { DialogBody, DialogFooter } from "../components/Dialog";
import { Select, FormField, SecondaryButton } from "../components/forms";
import {
  type ExportFormat,
  FORMAT_EXTENSIONS,
  getFullFilename,
} from "../utils/reportExport";
import { caption } from "../styles/typography";
import { Button } from "../components/Button";

export type ExportReportDialogProps = {
  open: boolean;
  title: string;
  description: string;
  defaultFilename: string;
  defaultPath?: string;
  onCancel: () => void;
  onExport: (format: ExportFormat, filename: string) => void;
};

export default function ExportReportDialog({
  open,
  title,
  description,
  defaultFilename,
  defaultPath,
  onCancel,
  onExport,
}: ExportReportDialogProps) {
  const { t } = useTranslation("dialogs");
  const [format, setFormat] = useState<ExportFormat>("text");

  const handleExport = () => {
    // Build full path with date prefix
    const fullFilename = getFullFilename(defaultFilename, format);
    const fullPath = defaultPath
      ? (defaultPath.endsWith('/') ? `${defaultPath}${fullFilename}` : `${defaultPath}/${fullFilename}`)
      : fullFilename;
    onExport(format, fullPath);
  };

  return (
    <Dialog isOpen={open} onClose={onCancel}>
      <DialogBody className="space-y-4">
        <div className="text-lg font-semibold text-primary">
          {title}
        </div>
        <div className="text-sm text-secondary">
          {description}
        </div>

        <div className="grid grid-cols-1 gap-3">
          <FormField label={t("exportReport.format")} variant="simple">
            <Select
              size="lg"
              value={format}
              onChange={(e) => setFormat(e.target.value as ExportFormat)}
            >
              {(Object.keys(FORMAT_EXTENSIONS) as ExportFormat[]).map((f) => (
                <option key={f} value={f}>{t(`exportReport.formats.${f}.label`)}</option>
              ))}
            </Select>
          </FormField>

          <div className={`${caption} -mt-1`}>
            {t(`exportReport.formats.${format}.description`)}
          </div>
        </div>
      </DialogBody>
      <DialogFooter>
        <SecondaryButton
          onClick={onCancel}
        >
          {t("common:actions.cancel")}
        </SecondaryButton>
        <Button
          onClick={handleExport}
          variant="solid"
          tone="purple"
          size="lg"
        >
          {t("common:actions.saveAs")}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
