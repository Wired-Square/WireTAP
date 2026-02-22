// ui/src/apps/settings/views/GeneralView.tsx

import Input from "../../../components/forms/Input";
import Select from "../../../components/forms/Select";
import { labelDefault, helpText } from "../../../styles";
import { textPrimary } from "../../../styles/colourTokens";

type DefaultFrameType = "can" | "modbus" | "serial";

type GeneralViewProps = {
  discoveryHistoryBuffer: number;
  onChangeDiscoveryHistoryBuffer: (value: number) => void;
  defaultFrameType: DefaultFrameType;
  onChangeDefaultFrameType: (value: DefaultFrameType) => void;
  queryResultLimit: number;
  onChangeQueryResultLimit: (value: number) => void;
  graphBufferSize: number;
  onChangeGraphBufferSize: (value: number) => void;
  preventIdleSleep: boolean;
  onChangePreventIdleSleep: (value: boolean) => void;
  keepDisplayAwake: boolean;
  onChangeKeepDisplayAwake: (value: boolean) => void;
  enableFileLogging: boolean;
  onChangeEnableFileLogging: (value: boolean) => void;
  isIOS?: boolean;
};

export default function GeneralView({
  discoveryHistoryBuffer,
  onChangeDiscoveryHistoryBuffer,
  defaultFrameType,
  onChangeDefaultFrameType,
  queryResultLimit,
  onChangeQueryResultLimit,
  graphBufferSize,
  onChangeGraphBufferSize,
  preventIdleSleep,
  onChangePreventIdleSleep,
  keepDisplayAwake,
  onChangeKeepDisplayAwake,
  enableFileLogging,
  onChangeEnableFileLogging,
  isIOS = false,
}: GeneralViewProps) {
  return (
    <div className="space-y-6">
      <h2 className="text-xl font-semibold text-[color:var(--text-primary)]">General</h2>

      <div className="space-y-2">
        <label className={labelDefault}>Default Frame Type</label>
        <p className={helpText}>
          Protocol type used when adding new frames (can be overridden per catalog)
        </p>
        <Select
          value={defaultFrameType}
          onChange={(e) => onChangeDefaultFrameType(e.target.value as DefaultFrameType)}
        >
          <option value="can">CAN</option>
          <option value="modbus">Modbus</option>
          <option value="serial">Serial</option>
        </Select>
      </div>

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

      {/* Power Management Section */}
      <div className="pt-4 border-t border-[color:var(--border-default)]">
        <h3 className={`text-lg font-medium mb-4 ${textPrimary}`}>Power Management</h3>
        <div className="space-y-4">
          {/* Prevent idle sleep: desktop only (uses keepawake crate) */}
          {!isIOS && (
            <label className="flex items-start gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={preventIdleSleep}
                onChange={(e) => onChangePreventIdleSleep(e.target.checked)}
                className="mt-1"
              />
              <div>
                <span className={labelDefault}>
                  Prevent idle sleep during active sessions
                </span>
                <p className={helpText}>
                  Keep the system awake while a session is actively streaming data
                </p>
              </div>
            </label>
          )}

          {/* Keep display awake: all platforms (iOS uses tauri-plugin-keep-screen-on) */}
          <label className="flex items-start gap-3 cursor-pointer">
            <input
              type="checkbox"
              checked={keepDisplayAwake}
              onChange={(e) => onChangeKeepDisplayAwake(e.target.checked)}
              className="mt-1"
            />
            <div>
              <span className={labelDefault}>
                Keep display awake during active sessions
              </span>
              <p className={helpText}>
                Prevent the display from turning off while a session is active
              </p>
            </div>
          </label>
        </div>
      </div>

      {/* Diagnostics Section */}
      <div className="pt-4 border-t border-[color:var(--border-default)]">
        <h3 className={`text-lg font-medium mb-4 ${textPrimary}`}>Diagnostics</h3>
        <div className="space-y-4">
          <label className="flex items-start gap-3 cursor-pointer">
            <input
              type="checkbox"
              checked={enableFileLogging}
              onChange={(e) => onChangeEnableFileLogging(e.target.checked)}
              className="mt-1"
            />
            <div>
              <span className={labelDefault}>
                Log to file
              </span>
              <p className={helpText}>
                Write diagnostic logs to ~/Documents/CANdor/Reports/
              </p>
            </div>
          </label>
        </div>
      </div>
    </div>
  );
}
