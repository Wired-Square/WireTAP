// ui/src/apps/settings/views/CapturesView.tsx

import { useTranslation } from "react-i18next";
import Select from "../../../components/forms/Select";
import { h2 } from "../../../styles";
import {
  SettingSection,
  SettingRow,
  SettingToggleRow,
  BoundedNumberInput,
} from "../components/rows";

type CapturesViewProps = {
  clearCapturesOnStart: boolean;
  onChangeClearCapturesOnStart: (value: boolean) => void;
  captureStorage: string;
  onChangeCaptureStorage: (value: string) => void;
  discoveryHistorySize: number;
  onChangeDiscoveryHistorySize: (value: number) => void;
  queryResultLimit: number;
  onChangeQueryResultLimit: (value: number) => void;
  graphBufferSize: number;
  onChangeGraphBufferSize: (value: number) => void;
  decoderMaxUnmatchedFrames: number;
  onChangeDecoderMaxUnmatchedFrames: (value: number) => void;
  decoderMaxFilteredFrames: number;
  onChangeDecoderMaxFilteredFrames: (value: number) => void;
  decoderMaxDecodedFrames: number;
  onChangeDecoderMaxDecodedFrames: (value: number) => void;
  decoderMaxDecodedPerSource: number;
  onChangeDecoderMaxDecodedPerSource: (value: number) => void;
  transmitMaxHistory: number;
  onChangeTransmitMaxHistory: (value: number) => void;
};

export default function CapturesView({
  clearCapturesOnStart,
  onChangeClearCapturesOnStart,
  captureStorage,
  onChangeCaptureStorage,
  discoveryHistorySize,
  onChangeDiscoveryHistorySize,
  queryResultLimit,
  onChangeQueryResultLimit,
  graphBufferSize,
  onChangeGraphBufferSize,
  decoderMaxUnmatchedFrames,
  onChangeDecoderMaxUnmatchedFrames,
  decoderMaxFilteredFrames,
  onChangeDecoderMaxFilteredFrames,
  decoderMaxDecodedFrames,
  onChangeDecoderMaxDecodedFrames,
  decoderMaxDecodedPerSource,
  onChangeDecoderMaxDecodedPerSource,
  transmitMaxHistory,
  onChangeTransmitMaxHistory,
}: CapturesViewProps) {
  const { t } = useTranslation("settings");

  return (
    <div className="space-y-6">
      <h2 className={h2}>{t("captures.title")}</h2>

      <SettingSection title={t("captures.storage.title")} divider={false}>
        <SettingRow label={t("captures.storage.label")} help={t("captures.storage.help")}>
          <Select value={captureStorage} onChange={(e) => onChangeCaptureStorage(e.target.value)}>
            <option value="sqlite">{t("captures.storage.options.sqlite")}</option>
          </Select>
        </SettingRow>

        <SettingToggleRow
          label={t("captures.clearOnStart.label")}
          help={t("captures.clearOnStart.help")}
          checked={clearCapturesOnStart}
          onChange={onChangeClearCapturesOnStart}
        />
      </SettingSection>

      <SettingSection title={t("captures.buffers.title")}>
        <SettingRow
          label={t("captures.buffers.discoveryHistory.label")}
          help={t("captures.buffers.discoveryHistory.help")}
        >
          <BoundedNumberInput
            boundKey="discoveryHistorySize"
            value={discoveryHistorySize}
            onChange={onChangeDiscoveryHistorySize}
          />
        </SettingRow>

        <SettingRow
          label={t("captures.buffers.queryResultLimit.label")}
          help={t("captures.buffers.queryResultLimit.help")}
        >
          <BoundedNumberInput
            boundKey="queryResultLimit"
            value={queryResultLimit}
            onChange={onChangeQueryResultLimit}
          />
        </SettingRow>

        <SettingRow
          label={t("captures.buffers.graphBuffer.label")}
          help={t("captures.buffers.graphBuffer.help")}
        >
          <BoundedNumberInput
            boundKey="graphBufferSize"
            value={graphBufferSize}
            onChange={onChangeGraphBufferSize}
          />
        </SettingRow>
      </SettingSection>

      <SettingSection title={t("captures.decoderLimits.title")}>
        <SettingRow
          label={t("captures.decoderLimits.maxUnmatched.label")}
          help={t("captures.decoderLimits.maxUnmatched.help")}
        >
          <BoundedNumberInput
            boundKey="decoderMaxUnmatchedFrames"
            value={decoderMaxUnmatchedFrames}
            onChange={onChangeDecoderMaxUnmatchedFrames}
          />
        </SettingRow>

        <SettingRow
          label={t("captures.decoderLimits.maxFiltered.label")}
          help={t("captures.decoderLimits.maxFiltered.help")}
        >
          <BoundedNumberInput
            boundKey="decoderMaxFilteredFrames"
            value={decoderMaxFilteredFrames}
            onChange={onChangeDecoderMaxFilteredFrames}
          />
        </SettingRow>

        <SettingRow
          label={t("captures.decoderLimits.maxDecoded.label")}
          help={t("captures.decoderLimits.maxDecoded.help")}
        >
          <BoundedNumberInput
            boundKey="decoderMaxDecodedFrames"
            value={decoderMaxDecodedFrames}
            onChange={onChangeDecoderMaxDecodedFrames}
          />
        </SettingRow>

        <SettingRow
          label={t("captures.decoderLimits.maxDecodedPerSource.label")}
          help={t("captures.decoderLimits.maxDecodedPerSource.help")}
        >
          <BoundedNumberInput
            boundKey="decoderMaxDecodedPerSource"
            value={decoderMaxDecodedPerSource}
            onChange={onChangeDecoderMaxDecodedPerSource}
          />
        </SettingRow>
      </SettingSection>

      <SettingSection title={t("captures.transmit.title")}>
        <SettingRow
          label={t("captures.transmit.maxHistory.label")}
          help={t("captures.transmit.maxHistory.help")}
        >
          <BoundedNumberInput
            boundKey="transmitMaxHistory"
            value={transmitMaxHistory}
            onChange={onChangeTransmitMaxHistory}
          />
        </SettingRow>
      </SettingSection>
    </div>
  );
}
