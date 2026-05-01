// ui/src/apps/settings/views/CapturesView.tsx

import { useTranslation } from "react-i18next";
import Input from "../../../components/forms/Input";
import Select from "../../../components/forms/Select";
import { labelDefault, helpText } from "../../../styles";
import { textPrimary } from "../../../styles/colourTokens";

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
      <h2 className="text-xl font-semibold text-[color:var(--text-primary)]">
        {t("captures.title")}
      </h2>

      {/* Storage Section */}
      <div className="space-y-4">
        <h3 className={`text-lg font-medium ${textPrimary}`}>{t("captures.storage.title")}</h3>

        <div className="space-y-2">
          <label className={labelDefault}>{t("captures.storage.label")}</label>
          <p className={helpText}>{t("captures.storage.help")}</p>
          <Select
            value={captureStorage}
            onChange={(e) => onChangeCaptureStorage(e.target.value)}
          >
            <option value="sqlite">{t("captures.storage.options.sqlite")}</option>
          </Select>
        </div>

        <label className="flex items-start gap-3 cursor-pointer">
          <input
            type="checkbox"
            checked={clearCapturesOnStart}
            onChange={(e) => onChangeClearCapturesOnStart(e.target.checked)}
            className="mt-1"
          />
          <div>
            <span className={labelDefault}>{t("captures.clearOnStart.label")}</span>
            <p className={helpText}>{t("captures.clearOnStart.help")}</p>
          </div>
        </label>
      </div>

      {/* Buffer Sizes Section */}
      <div className="pt-4 border-t border-[color:var(--border-default)]">
        <h3 className={`text-lg font-medium mb-4 ${textPrimary}`}>{t("captures.buffers.title")}</h3>
        <div className="space-y-4">
          <div className="space-y-2">
            <label className={labelDefault}>{t("captures.buffers.discoveryHistory.label")}</label>
            <p className={helpText}>{t("captures.buffers.discoveryHistory.help")}</p>
            <Input
              type="number"
              min={1000}
              max={10000000}
              step={10000}
              value={discoveryHistorySize}
              onChange={(e) => {
                const value = Number(e.target.value);
                if (value >= 1000 && value <= 10000000) {
                  onChangeDiscoveryHistorySize(value);
                }
              }}
            />
          </div>

          <div className="space-y-2">
            <label className={labelDefault}>{t("captures.buffers.queryResultLimit.label")}</label>
            <p className={helpText}>{t("captures.buffers.queryResultLimit.help")}</p>
            <Input
              type="number"
              min={100}
              max={100000}
              step={1000}
              value={queryResultLimit}
              onChange={(e) => {
                const value = Number(e.target.value);
                if (value >= 100 && value <= 100000) {
                  onChangeQueryResultLimit(value);
                }
              }}
            />
          </div>

          <div className="space-y-2">
            <label className={labelDefault}>{t("captures.buffers.graphBuffer.label")}</label>
            <p className={helpText}>{t("captures.buffers.graphBuffer.help")}</p>
            <Input
              type="number"
              min={1000}
              max={100000}
              step={1000}
              value={graphBufferSize}
              onChange={(e) => {
                const value = Number(e.target.value);
                if (value >= 1000 && value <= 100000) {
                  onChangeGraphBufferSize(value);
                }
              }}
            />
          </div>
        </div>
      </div>

      {/* Decoder Limits Section */}
      <div className="pt-4 border-t border-[color:var(--border-default)]">
        <h3 className={`text-lg font-medium mb-4 ${textPrimary}`}>{t("captures.decoderLimits.title")}</h3>
        <div className="space-y-4">
          <div className="space-y-2">
            <label className={labelDefault}>{t("captures.decoderLimits.maxUnmatched.label")}</label>
            <p className={helpText}>{t("captures.decoderLimits.maxUnmatched.help")}</p>
            <Input
              type="number"
              min={100}
              max={10000}
              step={100}
              value={decoderMaxUnmatchedFrames}
              onChange={(e) => {
                const value = Number(e.target.value);
                if (value >= 100 && value <= 10000) {
                  onChangeDecoderMaxUnmatchedFrames(value);
                }
              }}
            />
          </div>

          <div className="space-y-2">
            <label className={labelDefault}>{t("captures.decoderLimits.maxFiltered.label")}</label>
            <p className={helpText}>{t("captures.decoderLimits.maxFiltered.help")}</p>
            <Input
              type="number"
              min={100}
              max={10000}
              step={100}
              value={decoderMaxFilteredFrames}
              onChange={(e) => {
                const value = Number(e.target.value);
                if (value >= 100 && value <= 10000) {
                  onChangeDecoderMaxFilteredFrames(value);
                }
              }}
            />
          </div>

          <div className="space-y-2">
            <label className={labelDefault}>{t("captures.decoderLimits.maxDecoded.label")}</label>
            <p className={helpText}>{t("captures.decoderLimits.maxDecoded.help")}</p>
            <Input
              type="number"
              min={100}
              max={5000}
              step={100}
              value={decoderMaxDecodedFrames}
              onChange={(e) => {
                const value = Number(e.target.value);
                if (value >= 100 && value <= 5000) {
                  onChangeDecoderMaxDecodedFrames(value);
                }
              }}
            />
          </div>

          <div className="space-y-2">
            <label className={labelDefault}>{t("captures.decoderLimits.maxDecodedPerSource.label")}</label>
            <p className={helpText}>{t("captures.decoderLimits.maxDecodedPerSource.help")}</p>
            <Input
              type="number"
              min={500}
              max={20000}
              step={500}
              value={decoderMaxDecodedPerSource}
              onChange={(e) => {
                const value = Number(e.target.value);
                if (value >= 500 && value <= 20000) {
                  onChangeDecoderMaxDecodedPerSource(value);
                }
              }}
            />
          </div>
        </div>
      </div>

      {/* Transmit Section */}
      <div className="pt-4 border-t border-[color:var(--border-default)]">
        <h3 className={`text-lg font-medium mb-4 ${textPrimary}`}>{t("captures.transmit.title")}</h3>
        <div className="space-y-4">
          <div className="space-y-2">
            <label className={labelDefault}>{t("captures.transmit.maxHistory.label")}</label>
            <p className={helpText}>{t("captures.transmit.maxHistory.help")}</p>
            <Input
              type="number"
              min={100}
              max={10000}
              step={100}
              value={transmitMaxHistory}
              onChange={(e) => {
                const value = Number(e.target.value);
                if (value >= 100 && value <= 10000) {
                  onChangeTransmitMaxHistory(value);
                }
              }}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
