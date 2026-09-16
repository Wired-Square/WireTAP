// ui/src/apps/discovery/views/tools/ModbusFunctionCodePanel.tsx
//
// "Which function codes does this thing answer?" — the cheapest first question
// to ask an unknown Modbus device, and the one that decides what a sweep should
// even look for. Four requests per unit, run inline rather than as a session
// because it produces an answer rather than a stream.
//
// The answer still lands in a results tab, like every other tool's: a verdict
// table is something you read against a sweep you run next, not something to
// lose by closing the dialog it was launched from.

import { useState } from "react";
import { useTranslation } from "react-i18next";
import ModbusConnectionFields from "../../../../components/modbus/ModbusConnectionFields";
import { useModbusTarget } from "../../../../components/modbus/useModbusTarget";
import { FieldRow, NumberField, RunButton, ScanNote, TextField } from "../../../../components/modbus/ModbusFields";
import {
  MODBUS_SCAN_BOUNDS,
  MODBUS_SCAN_DEFAULTS,
} from "../../../../components/modbus/modbusScanDefaults";
import type { FcProbeConfig } from "../../../../api/io";

type Props = {
  /** `deviceName` is what the results tab is headed with — the profile's name when one was picked. */
  onStartProbe: (config: FcProbeConfig, deviceName: string) => void;
};

export default function ModbusFunctionCodePanel({ onStartProbe }: Props) {
  const { t } = useTranslation("discovery");
  const target = useModbusTarget();

  // Lead with the profile's own unit — the one you actually care about — then the
  // usual suspects for a gateway fronting more than one slave.
  const [unitIdsText, setUnitIdsText] = useState(`${target.connection.unit_id}, 0, 255`);
  const [testRegister, setTestRegister] = useState(0);
  const [timeoutMs, setTimeoutMs] = useState(MODBUS_SCAN_DEFAULTS.timeoutMs);

  const unitIds = unitIdsText
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n >= 0 && n <= 255);

  const handleProbe = () =>
    onStartProbe(
      {
        host: target.connection.host,
        port: target.connection.port,
        unit_ids: unitIds,
        test_register: testRegister,
        timeout_ms: timeoutMs,
      },
      target.name
    );

  return (
    <div className="space-y-3 text-xs">
      <ModbusConnectionFields target={target} showUnitId={false} />

      <FieldRow>
        <TextField
          label={t("modbusFc.unitIds")}
          value={unitIdsText}
          onChange={setUnitIdsText}
          placeholder="1, 0, 255"
        />
        <NumberField
          label={t("modbusFc.testRegister")}
          value={testRegister}
          onChange={setTestRegister}
          min={MODBUS_SCAN_BOUNDS.register.min}
          max={MODBUS_SCAN_BOUNDS.register.max}
        />
        <NumberField
          label={t("modbusRegister.timeoutMs")}
          value={timeoutMs}
          onChange={setTimeoutMs}
          min={MODBUS_SCAN_BOUNDS.timeoutMs.min}
          max={MODBUS_SCAN_BOUNDS.timeoutMs.max}
        />
      </FieldRow>

      <ScanNote ready={target.hasAddress}>
        {t("modbusFc.description", { count: unitIds.length, requests: unitIds.length * 4 })}
      </ScanNote>

      <RunButton
        label={t("modbusFc.runProbe")}
        onClick={handleProbe}
        disabled={!target.hasAddress || unitIds.length === 0}
      />
    </div>
  );
}
