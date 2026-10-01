import { useTranslation } from "react-i18next";
import Dialog, { DialogBody, DialogFooter } from "../components/Dialog";
import { Alert } from "../components/Alert";
import { PrimaryButton } from "../components/forms";
import { textMuted } from "../styles";
import type { CandumpImportResult } from "../api/capture";

type Props = {
  result: CandumpImportResult;
  onDone: () => void;
};

export default function CandumpImportReportDialog({ result, onDone }: Props) {
  const { t } = useTranslation("dialogs");
  const unlisted = result.skipped_count - result.skipped.length;

  return (
    <Dialog isOpen onClose={onDone} size="lg" title={t("candumpImport.title")}>
      <DialogBody>
        <Alert tone="warning">
          {t("candumpImport.summary", {
            frames: result.metadata.count.toLocaleString(),
            count: result.skipped_count,
          })}
        </Alert>
        <div className={`mt-3 max-h-48 overflow-y-auto font-mono text-xs ${textMuted}`}>
          {result.skipped.map((skip) => (
            <div key={`${skip.file}:${skip.line}`} className="py-0.5">
              {t("candumpImport.line", { file: skip.file, line: skip.line, message: skip.message })}
            </div>
          ))}
          {unlisted > 0 && <div className="py-0.5">{t("candumpImport.more", { count: unlisted })}</div>}
        </div>
      </DialogBody>
      <DialogFooter>
        <PrimaryButton onClick={onDone}>{t("candumpImport.done")}</PrimaryButton>
      </DialogFooter>
    </Dialog>
  );
}
