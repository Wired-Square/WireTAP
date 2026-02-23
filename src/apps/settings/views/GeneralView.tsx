// ui/src/apps/settings/views/GeneralView.tsx

import Select from "../../../components/forms/Select";
import { labelDefault, helpText } from "../../../styles";
import { textPrimary } from "../../../styles/colourTokens";

type DefaultFrameType = "can" | "modbus" | "serial";

type GeneralViewProps = {
  defaultFrameType: DefaultFrameType;
  onChangeDefaultFrameType: (value: DefaultFrameType) => void;
  preventIdleSleep: boolean;
  onChangePreventIdleSleep: (value: boolean) => void;
  keepDisplayAwake: boolean;
  onChangeKeepDisplayAwake: (value: boolean) => void;
  logLevel: string;
  onChangeLogLevel: (value: string) => void;
  isIOS?: boolean;
};

export default function GeneralView({
  defaultFrameType,
  onChangeDefaultFrameType,
  preventIdleSleep,
  onChangePreventIdleSleep,
  keepDisplayAwake,
  onChangeKeepDisplayAwake,
  logLevel,
  onChangeLogLevel,
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
        <div className="space-y-2">
          <label className={labelDefault}>Log Level</label>
          <p className={helpText}>
            Diagnostic log verbosity. Logs are written to ~/Documents/CANdor/Reports/
          </p>
          <Select
            value={logLevel}
            onChange={(e) => onChangeLogLevel(e.target.value)}
          >
            <option value="off">Off</option>
            <option value="info">Info</option>
            <option value="debug">Debug</option>
            <option value="verbose">Verbose</option>
          </Select>
        </div>
      </div>
    </div>
  );
}
