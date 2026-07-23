// ui/src/apps/settings/views/LocationsView.tsx
import { useTranslation } from "react-i18next";
import { h2, h3 } from "../../../styles";
import type { DirectoryValidation } from "../stores/settingsStore";
import { SettingDirectoryRow, SettingRadioGroup } from "../components/rows";

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
        <h2 className={`${h2} mb-4`}>{t("locations.title")}</h2>

        <SettingDirectoryRow
          label={t("locations.decoderDir.label")}
          value={decoderDir}
          onChange={onChangeDecoderDir}
          onPick={onPickDecoderDir}
          placeholder={placeholder}
          browseTooltip={browseTooltip}
          error={decoderValidation?.error}
          help={t("locations.decoderDir.help")}
        />

        <SettingDirectoryRow
          label={t("locations.dumpDir.label")}
          value={dumpDir}
          onChange={onChangeDumpDir}
          onPick={onPickDumpDir}
          placeholder={placeholder}
          browseTooltip={browseTooltip}
          error={dumpValidation?.error}
          help={t("locations.dumpDir.help")}
        />

        <SettingDirectoryRow
          label={t("locations.reportDir.label")}
          value={reportDir}
          onChange={onChangeReportDir}
          onPick={onPickReportDir}
          placeholder={placeholder}
          browseTooltip={browseTooltip}
          error={reportValidation?.error}
          help={t("locations.reportDir.help")}
        />

        {/* Files */}
        <div>
          <h3 className={`${h3} mb-3`}>{t("locations.filesTitle")}</h3>
          <SettingRadioGroup
            label={t("locations.saveFrameIdFormat.label")}
            name="save-frame-id-format"
            value={saveFrameIdFormat}
            onChange={onChangeSaveFrameIdFormat}
            options={[
              { value: "hex", label: t("locations.saveFrameIdFormat.options.hex") },
              { value: "decimal", label: t("locations.saveFrameIdFormat.options.decimal") },
            ]}
            help={t("locations.saveFrameIdFormat.help")}
          />
        </div>
      </div>
    </div>
  );
}
