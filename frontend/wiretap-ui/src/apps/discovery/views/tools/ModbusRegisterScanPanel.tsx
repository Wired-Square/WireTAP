// ui/src/apps/discovery/views/tools/ModbusRegisterScanPanel.tsx

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronRight } from "lucide-react";
import { iconSm } from "../../../../styles/spacing";
import { borderDefault, textMuted } from "../../../../styles";
import ModbusConnectionFields from "../../../../components/modbus/ModbusConnectionFields";
import { useModbusTarget } from "../../../../components/modbus/useModbusTarget";
import {
  CheckboxRow,
  FieldRow,
  NumberField,
  RunButton,
  ScanNote,
  SelectField,
  registerTypeOptions,
} from "../../../../components/modbus/ModbusFields";
import {
  MODBUS_SCAN_BOUNDS,
  MODBUS_SCAN_DEFAULTS,
  maxChunkFor,
} from "../../../../components/modbus/modbusScanDefaults";
import type { ModbusScanConfig, ModbusRegisterType } from "../../../../api/io";

type Props = {
  onStartScan: (config: ModbusScanConfig) => void;
};

export default function ModbusRegisterScanPanel({ onStartScan }: Props) {
  const { t } = useTranslation("discovery");
  const target = useModbusTarget();

  const [registerType, setRegisterType] = useState<ModbusRegisterType>(
    MODBUS_SCAN_DEFAULTS.registerType
  );
  const [startRegister, setStartRegister] = useState(MODBUS_SCAN_DEFAULTS.startRegister);
  const [endRegister, setEndRegister] = useState(MODBUS_SCAN_DEFAULTS.endRegister);
  const [chunkSize, setChunkSize] = useState(maxChunkFor(MODBUS_SCAN_DEFAULTS.registerType));
  const [delayMs, setDelayMs] = useState(MODBUS_SCAN_DEFAULTS.interRequestDelayMs);
  const [repeat, setRepeat] = useState(MODBUS_SCAN_DEFAULTS.repeat);
  const [repeatDelayMs, setRepeatDelayMs] = useState(MODBUS_SCAN_DEFAULTS.repeatDelayMs);

  const [showAdvanced, setShowAdvanced] = useState(false);
  const [timeoutMs, setTimeoutMs] = useState(MODBUS_SCAN_DEFAULTS.timeoutMs);
  const [reconnectPerRequest, setReconnectPerRequest] = useState(
    MODBUS_SCAN_DEFAULTS.reconnectPerRequest
  );
  const [connectSettleMs, setConnectSettleMs] = useState(MODBUS_SCAN_DEFAULTS.connectSettleMs);
  const [maxConsecutiveTimeouts, setMaxConsecutiveTimeouts] = useState(
    MODBUS_SCAN_DEFAULTS.maxConsecutiveTimeouts
  );
  const [maxRequests, setMaxRequests] = useState(MODBUS_SCAN_DEFAULTS.maxRequests);

  const maxChunk = maxChunkFor(registerType);

  const handleRegisterTypeChange = (type: ModbusRegisterType) => {
    setRegisterType(type);
    setChunkSize(maxChunkFor(type));
  };

  // Per-request reconnect and a settle delay go together: both exist for cheap
  // stacks that serve one conversation per socket, and such a device usually
  // needs a moment after connecting before its first reply is readable.
  const handleReconnectChange = (on: boolean) => {
    setReconnectPerRequest(on);
    if (on && connectSettleMs === 0) {
      setConnectSettleMs(MODBUS_SCAN_DEFAULTS.connectSettleWithReconnectMs);
    }
  };

  const registerCount = Math.max(0, endRegister - startRegister + 1);
  const overRegisterCap = registerCount > MODBUS_SCAN_DEFAULTS.maxRegisters;
  const isValid =
    target.hasAddress && startRegister <= endRegister && chunkSize > 0 && !overRegisterCap;

  const handleStart = () => {
    onStartScan({
      host: target.connection.host,
      port: target.connection.port,
      unit_id: target.connection.unit_id,
      register_type: registerType,
      start_register: startRegister,
      end_register: endRegister,
      chunk_size: Math.min(chunkSize, maxChunk),
      inter_request_delay_ms: delayMs,
      timeout_ms: timeoutMs,
      connect_settle_ms: connectSettleMs,
      reconnect_per_request: reconnectPerRequest,
      max_consecutive_timeouts: maxConsecutiveTimeouts,
      max_requests: maxRequests,
      repeat,
      repeat_delay_ms: repeatDelayMs,
    });
  };

  return (
    <div className="space-y-3 text-xs">
      <ModbusConnectionFields target={target} />

      <FieldRow>
        <SelectField
          label={t("modbusRegister.registerType")}
          value={registerType}
          onChange={handleRegisterTypeChange}
          options={registerTypeOptions(t)}
        />
        <NumberField
          label={t("modbusRegister.startRegister")}
          value={startRegister}
          onChange={setStartRegister}
          min={MODBUS_SCAN_BOUNDS.register.min}
          max={MODBUS_SCAN_BOUNDS.register.max}
        />
        <NumberField
          label={t("modbusRegister.endRegister")}
          value={endRegister}
          onChange={setEndRegister}
          min={MODBUS_SCAN_BOUNDS.register.min}
          max={MODBUS_SCAN_BOUNDS.register.max}
        />
      </FieldRow>

      <FieldRow>
        <NumberField
          label={t("modbusRegister.chunkSize")}
          value={chunkSize}
          onChange={setChunkSize}
          min={1}
          max={maxChunk}
        />
        <NumberField
          label={t("modbusRegister.delayMs")}
          value={delayMs}
          onChange={setDelayMs}
          min={MODBUS_SCAN_BOUNDS.delayMs.min}
          max={MODBUS_SCAN_BOUNDS.delayMs.max}
        />
      </FieldRow>

      <FieldRow>
        <NumberField
          label={t("modbusRegister.passes")}
          value={repeat}
          onChange={setRepeat}
          min={MODBUS_SCAN_BOUNDS.repeat.min}
          max={MODBUS_SCAN_BOUNDS.repeat.max}
        />
        <NumberField
          label={t("modbusRegister.passGapMs")}
          value={repeatDelayMs}
          onChange={setRepeatDelayMs}
          min={MODBUS_SCAN_BOUNDS.repeatDelayMs.min}
          max={MODBUS_SCAN_BOUNDS.repeatDelayMs.max}
          disabled={repeat < 2}
        />
      </FieldRow>
      {repeat > 1 && <p className={textMuted}>{t("modbusRegister.passesHint")}</p>}

      <button
        type="button"
        onClick={() => setShowAdvanced((v) => !v)}
        className={`flex items-center gap-1 ${textMuted} hover:text-[color:var(--text-primary)]`}
      >
        {showAdvanced ? <ChevronDown className={iconSm} /> : <ChevronRight className={iconSm} />}
        {t("modbusRegister.advanced")}
      </button>

      {showAdvanced && (
        <div className={`space-y-3 pl-2 border-l ${borderDefault}`}>
          <FieldRow>
            <NumberField
              label={t("modbusRegister.timeoutMs")}
              value={timeoutMs}
              onChange={setTimeoutMs}
              min={MODBUS_SCAN_BOUNDS.timeoutMs.min}
              max={MODBUS_SCAN_BOUNDS.timeoutMs.max}
            />
            <NumberField
              label={t("modbusRegister.maxConsecutiveTimeouts")}
              value={maxConsecutiveTimeouts}
              onChange={setMaxConsecutiveTimeouts}
              min={MODBUS_SCAN_BOUNDS.consecutiveTimeouts.min}
              max={MODBUS_SCAN_BOUNDS.consecutiveTimeouts.max}
            />
          </FieldRow>
          <FieldRow>
            <NumberField
              label={t("modbusRegister.maxRequests")}
              value={maxRequests}
              onChange={setMaxRequests}
              min={MODBUS_SCAN_BOUNDS.maxRequests.min}
              max={MODBUS_SCAN_BOUNDS.maxRequests.max}
            />
            <NumberField
              label={t("modbusRegister.connectSettleMs")}
              value={connectSettleMs}
              onChange={setConnectSettleMs}
              min={MODBUS_SCAN_BOUNDS.settleMs.min}
              max={MODBUS_SCAN_BOUNDS.settleMs.max}
            />
          </FieldRow>
          <FieldRow>
            <CheckboxRow
              label={t("modbusRegister.reconnectPerRequest")}
              checked={reconnectPerRequest}
              onChange={handleReconnectChange}
            />
          </FieldRow>
          <p className={textMuted}>{t("modbusRegister.advancedHint")}</p>
        </div>
      )}

      <ScanNote ready={target.hasAddress}>
        {t("modbusRegister.scanDescription", {
          device: target.name,
          unit: target.connection.unit_id,
          type: registerType,
          start: startRegister,
          end: endRegister,
        })}
      </ScanNote>
      {overRegisterCap && (
        <p className="text-amber-500">
          {t("modbusRegister.tooManyRegisters", {
            count: registerCount,
            max: MODBUS_SCAN_DEFAULTS.maxRegisters,
          })}
        </p>
      )}

      <RunButton label={t("modbusRegister.runScan")} onClick={handleStart} disabled={!isValid} />
    </div>
  );
}
