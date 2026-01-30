// ui/src/apps/settings/views/GeneralView.tsx

import Input from "../../../components/forms/Input";
import Select from "../../../components/forms/Select";
import { labelDefault, helpText } from "../../../styles";

type DefaultFrameType = "can" | "modbus" | "serial";

type GeneralViewProps = {
  discoveryHistoryBuffer: number;
  onChangeDiscoveryHistoryBuffer: (value: number) => void;
  defaultFrameType: DefaultFrameType;
  onChangeDefaultFrameType: (value: DefaultFrameType) => void;
};

export default function GeneralView({
  discoveryHistoryBuffer,
  onChangeDiscoveryHistoryBuffer,
  defaultFrameType,
  onChangeDefaultFrameType,
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
    </div>
  );
}
