// ui/src/dialogs/ExportReportDialog.tsx
// Generic export dialog for analysis reports

import { useState } from "react";
import Dialog from "../components/Dialog";
import { Select, FormField, SecondaryButton } from "../components/forms";
import {
  type ExportFormat,
  FORMAT_DESCRIPTIONS,
  FORMAT_OPTIONS,
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
    <Dialog isOpen={open} maxWidth="max-w-md">
      <div className="p-6 space-y-4">
        <div className="text-lg font-semibold text-[color:var(--text-primary)]">
          {title}
        </div>
        <div className="text-sm text-[color:var(--text-secondary)]">
          {description}
        </div>

        <div className="grid grid-cols-1 gap-3">
          <FormField label="Format" variant="simple">
            <Select
              size="lg"
              value={format}
              onChange={(e) => setFormat(e.target.value as ExportFormat)}
            >
              {FORMAT_OPTIONS.map(opt => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </Select>
          </FormField>

          <div className={`${caption} -mt-1`}>
            {FORMAT_DESCRIPTIONS[format]}
          </div>
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <SecondaryButton
            onClick={onCancel}
          >
            Cancel
          </SecondaryButton>
          <Button
            onClick={handleExport}
            variant="solid"
            tone="purple"
            size="lg"
          >
            Save As...
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
