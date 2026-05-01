// ui/src/apps/settings/views/LocationsView.tsx
import { FolderOpen, AlertCircle } from "lucide-react";
import { useTranslation } from "react-i18next";
import { iconMd, iconLg } from "../../../styles/spacing";
import { caption, textMedium, focusRing, folderPickerButton } from "../../../styles";
import type { DirectoryValidation } from "../stores/settingsStore";

type LocationsViewProps = {
  decoderDir: string;
  dumpDir: string;
  reportDir: string;
  saveFrameIdFormat: "hex" | "decimal";
  decoderValidation: DirectoryValidation | null;
  dumpValidation: DirectoryValidation | null;
  reportValidation: DirectoryValidation | null;
  onChangeDecoderDir: (v: string) => void;
  onChangeDumpDir: (v: string) => void;
  onChangeReportDir: (v: string) => void;
  onChangeSaveFrameIdFormat: (v: "hex" | "decimal") => void;
  onPickDecoderDir: () => void;
  onPickDumpDir: () => void;
  onPickReportDir: () => void;
};

export default function LocationsView({
  decoderDir,
  dumpDir,
  reportDir,
  saveFrameIdFormat,
  decoderValidation,
  dumpValidation,
  reportValidation,
  onChangeDecoderDir,
  onChangeDumpDir,
  onChangeReportDir,
  onChangeSaveFrameIdFormat,
  onPickDecoderDir,
  onPickDumpDir,
  onPickReportDir,
}: LocationsViewProps) {
  const { t } = useTranslation("settings");
  const placeholder = t("locations.directoryPlaceholder");
  const browseTooltip = t("locations.browseTooltip");

  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-xl font-semibold text-[color:var(--text-primary)] mb-4">
          {t("locations.title")}
        </h2>

        {/* Decoder Directory */}
        <div className="mb-6">
          <label className={`block ${textMedium} mb-2`}>
            {t("locations.decoderDir.label")}
          </label>
          <div className="flex gap-2">
            <input
              type="text"
              value={decoderDir}
              onChange={(e) => onChangeDecoderDir(e.target.value)}
              className={`flex-1 px-4 py-2 bg-[var(--bg-surface)] border border-[color:var(--border-default)] rounded-lg text-[color:var(--text-primary)] ${focusRing}`}
              placeholder={placeholder}
            />
            <button
              onClick={onPickDecoderDir}
              className={folderPickerButton}
              title={browseTooltip}
            >
              <FolderOpen className={`${iconLg} text-[color:var(--text-muted)]`} />
            </button>
          </div>
          {decoderValidation?.error && (
            <div className="mt-2 flex items-center gap-2 text-sm text-[color:var(--text-amber)]">
              <AlertCircle className={iconMd} />
              <span>{decoderValidation.error}</span>
            </div>
          )}
          <p className="mt-2 text-sm text-[color:var(--text-muted)]">
            {t("locations.decoderDir.help")}
          </p>
        </div>

        {/* Dump Directory */}
        <div className="mb-6">
          <label className={`block ${textMedium} mb-2`}>
            {t("locations.dumpDir.label")}
          </label>
          <div className="flex gap-2">
            <input
              type="text"
              value={dumpDir}
              onChange={(e) => onChangeDumpDir(e.target.value)}
              className={`flex-1 px-4 py-2 bg-[var(--bg-surface)] border border-[color:var(--border-default)] rounded-lg text-[color:var(--text-primary)] ${focusRing}`}
              placeholder={placeholder}
            />
            <button
              onClick={onPickDumpDir}
              className={folderPickerButton}
              title={browseTooltip}
            >
              <FolderOpen className={`${iconLg} text-[color:var(--text-muted)]`} />
            </button>
          </div>
          {dumpValidation?.error && (
            <div className="mt-2 flex items-center gap-2 text-sm text-[color:var(--text-amber)]">
              <AlertCircle className={iconMd} />
              <span>{dumpValidation.error}</span>
            </div>
          )}
          <p className="mt-2 text-sm text-[color:var(--text-muted)]">
            {t("locations.dumpDir.help")}
          </p>
        </div>

        {/* Report Directory */}
        <div className="mb-6">
          <label className={`block ${textMedium} mb-2`}>
            {t("locations.reportDir.label")}
          </label>
          <div className="flex gap-2">
            <input
              type="text"
              value={reportDir}
              onChange={(e) => onChangeReportDir(e.target.value)}
              className={`flex-1 px-4 py-2 bg-[var(--bg-surface)] border border-[color:var(--border-default)] rounded-lg text-[color:var(--text-primary)] ${focusRing}`}
              placeholder={placeholder}
            />
            <button
              onClick={onPickReportDir}
              className={folderPickerButton}
              title={browseTooltip}
            >
              <FolderOpen className={`${iconLg} text-[color:var(--text-muted)]`} />
            </button>
          </div>
          {reportValidation?.error && (
            <div className="mt-2 flex items-center gap-2 text-sm text-[color:var(--text-amber)]">
              <AlertCircle className={iconMd} />
              <span>{reportValidation.error}</span>
            </div>
          )}
          <p className="mt-2 text-sm text-[color:var(--text-muted)]">
            {t("locations.reportDir.help")}
          </p>
        </div>

        {/* Files */}
        <div>
          <h2 className="text-lg font-semibold text-[color:var(--text-primary)] mb-3">
            {t("locations.filesTitle")}
          </h2>
          <div className="space-y-2">
            <div className={textMedium}>{t("locations.saveFrameIdFormat.label")}</div>
            <div className="flex items-center gap-4">
              <label className="flex items-center gap-2 text-sm text-[color:var(--text-secondary)]">
                <input
                  type="radio"
                  name="save-frame-id-format"
                  value="hex"
                  checked={saveFrameIdFormat === "hex"}
                  onChange={() => onChangeSaveFrameIdFormat("hex")}
                  className="accent-blue-600"
                />
                {t("locations.saveFrameIdFormat.options.hex")}
              </label>
              <label className="flex items-center gap-2 text-sm text-[color:var(--text-secondary)]">
                <input
                  type="radio"
                  name="save-frame-id-format"
                  value="decimal"
                  checked={saveFrameIdFormat === "decimal"}
                  onChange={() => onChangeSaveFrameIdFormat("decimal")}
                  className="accent-blue-600"
                />
                {t("locations.saveFrameIdFormat.options.decimal")}
              </label>
            </div>
            <p className={caption}>{t("locations.saveFrameIdFormat.help")}</p>
          </div>
        </div>
      </div>
    </div>
  );
}
