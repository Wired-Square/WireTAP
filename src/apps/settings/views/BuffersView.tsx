// ui/src/apps/settings/views/BuffersView.tsx

import Input from "../../../components/forms/Input";
import Select from "../../../components/forms/Select";
import { labelDefault, helpText } from "../../../styles";
import { textPrimary } from "../../../styles/colourTokens";

type BuffersViewProps = {
  clearBuffersOnStart: boolean;
  onChangeClearBuffersOnStart: (value: boolean) => void;
  bufferStorage: string;
  onChangeBufferStorage: (value: string) => void;
  discoveryHistoryBuffer: number;
  onChangeDiscoveryHistoryBuffer: (value: number) => void;
  queryResultLimit: number;
  onChangeQueryResultLimit: (value: number) => void;
  graphBufferSize: number;
  onChangeGraphBufferSize: (value: number) => void;
};

export default function BuffersView({
  clearBuffersOnStart,
  onChangeClearBuffersOnStart,
  bufferStorage,
  onChangeBufferStorage,
  discoveryHistoryBuffer,
  onChangeDiscoveryHistoryBuffer,
  queryResultLimit,
  onChangeQueryResultLimit,
  graphBufferSize,
  onChangeGraphBufferSize,
}: BuffersViewProps) {
  return (
    <div className="space-y-6">
      <h2 className="text-xl font-semibold text-[color:var(--text-primary)]">Buffers</h2>

      {/* Storage Section */}
      <div className="space-y-4">
        <h3 className={`text-lg font-medium ${textPrimary}`}>Storage</h3>

        <div className="space-y-2">
          <label className={labelDefault}>Buffer Storage</label>
          <p className={helpText}>
            Storage backend for captured frame data and imported buffers.
          </p>
          <Select
            value={bufferStorage}
            onChange={(e) => onChangeBufferStorage(e.target.value)}
          >
            <option value="sqlite">SQLite</option>
          </Select>
        </div>

        <label className="flex items-start gap-3 cursor-pointer">
          <input
            type="checkbox"
            checked={clearBuffersOnStart}
            onChange={(e) => onChangeClearBuffersOnStart(e.target.checked)}
            className="mt-1"
          />
          <div>
            <span className={labelDefault}>
              Clear buffers on start
            </span>
            <p className={helpText}>
              Delete all captured frame and byte data when the app launches.
              Disable to preserve buffer data across sessions (uses disk space).
            </p>
          </div>
        </label>
      </div>

      {/* Buffer Sizes Section */}
      <div className="pt-4 border-t border-[color:var(--border-default)]">
        <h3 className={`text-lg font-medium mb-4 ${textPrimary}`}>Buffer Sizes</h3>
        <div className="space-y-4">
          <div className="space-y-2">
            <label className={labelDefault}>Discovery History Buffer</label>
            <p className={helpText}>
              Maximum number of frames to keep in memory during CAN Discovery
            </p>
            <Input
              type="number"
              min={1000}
              max={10000000}
              step={10000}
              value={discoveryHistoryBuffer}
              onChange={(e) => {
                const value = Number(e.target.value);
                if (value >= 1000 && value <= 10000000) {
                  onChangeDiscoveryHistoryBuffer(value);
                }
              }}
            />
          </div>

          <div className="space-y-2">
            <label className={labelDefault}>Query Result Limit</label>
            <p className={helpText}>
              Maximum number of results returned by database queries in the Query app
            </p>
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
            <label className={labelDefault}>Graph Buffer Size</label>
            <p className={helpText}>
              Samples per signal in graph ring buffers. Higher values show more history but use more memory.
            </p>
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
    </div>
  );
}
