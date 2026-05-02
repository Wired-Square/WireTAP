// ui/src/apps/discovery/views/tools/ModbusUnitIdScanPanel.tsx

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Play, Info } from "lucide-react";
import { iconMd, iconSm } from "../../../../styles/spacing";
import { bgSurface, textMuted } from "../../../../styles";
import type { UnitIdScanConfig, ModbusRegisterType } from "../../../../api/io";

type Props = {
  connection: { host: string; port: number; unit_id: number };
  onStartScan: (config: UnitIdScanConfig) => void;
};

export default function ModbusUnitIdScanPanel({ connection, onStartScan }: Props) {
  const { t } = useTranslation("discovery");
  const [startUnitId, setStartUnitId] = useState(1);
  const [endUnitId, setEndUnitId] = useState(247);
  const [testRegister, setTestRegister] = useState(0);
  const [registerType, setRegisterType] = useState<ModbusRegisterType>("holding");
  const [delayMs, setDelayMs] = useState(50);

  const handleStart = () => {
    onStartScan({
      host: connection.host,
      port: connection.port,
      start_unit_id: startUnitId,
      end_unit_id: endUnitId,
      test_register: testRegister,
      register_type: registerType,
      inter_request_delay_ms: delayMs,
    });
  };

  const isValid = startUnitId <= endUnitId;

  return (
    <div className="space-y-3 text-xs">
      <div className="flex gap-3">
        <div className="flex-1 space-y-1">
          <label className="text-[color:var(--text-muted)]">{t("modbusUnitId.startUnitId")}</label>
          <input
            type="number"
            min={1}
            max={247}
            value={startUnitId}
            onChange={(e) => setStartUnitId(Math.max(1, Math.min(247, Number(e.target.value) || 1)))}
            className={`w-full px-2 py-1 rounded border border-[color:var(--border-default)] ${bgSurface} text-[color:var(--text-primary)]`}
          />
        </div>
        <div className="flex-1 space-y-1">
          <label className="text-[color:var(--text-muted)]">{t("modbusUnitId.endUnitId")}</label>
          <input
            type="number"
            min={1}
            max={247}
            value={endUnitId}
            onChange={(e) => setEndUnitId(Math.max(1, Math.min(247, Number(e.target.value) || 1)))}
            className={`w-full px-2 py-1 rounded border border-[color:var(--border-default)] ${bgSurface} text-[color:var(--text-primary)]`}
          />
        </div>
      </div>

      {/* FC43 info */}
      <div className="flex items-start gap-2 px-2 py-1.5 rounded bg-[var(--bg-surface)] border border-[color:var(--border-default)]">
        <Info className={`${iconSm} shrink-0 mt-0.5 text-purple-400`} />
        <span className={`${textMuted}`}>
          {t("modbusUnitId.fc43DescriptionPrefix")}
          <strong className="text-[color:var(--text-secondary)]">{t("modbusUnitId.fc43Title")}</strong>
          {t("modbusUnitId.fc43DescriptionSuffix")}
        </span>
      </div>

      {/* Fallback register config */}
      <div className="space-y-2 pt-1">
        <label className="text-[color:var(--text-muted)] text-[10px] uppercase tracking-wider">{t("modbusUnitId.fallbackProbe")}</label>
        <div className="flex gap-3">
          <div className="flex-1 space-y-1">
            <label className="text-[color:var(--text-muted)]">{t("modbusUnitId.register")}</label>
            <input
              type="number"
              min={0}
              max={65535}
              value={testRegister}
              onChange={(e) => setTestRegister(Math.max(0, Math.min(65535, Number(e.target.value) || 0)))}
              className={`w-full px-2 py-1 rounded border border-[color:var(--border-default)] ${bgSurface} text-[color:var(--text-primary)]`}
            />
          </div>
          <div className="flex-1 space-y-1">
            <label className="text-[color:var(--text-muted)]">{t("modbusUnitId.type")}</label>
            <select
              value={registerType}
              onChange={(e) => setRegisterType(e.target.value as ModbusRegisterType)}
              className={`w-full px-2 py-1 rounded border border-[color:var(--border-default)] ${bgSurface} text-[color:var(--text-primary)]`}
            >
              <option value="holding">{t("modbusUnitId.holdingFc")}</option>
              <option value="input">{t("modbusUnitId.inputFc")}</option>
              <option value="coil">{t("modbusUnitId.coilFc")}</option>
              <option value="discrete">{t("modbusUnitId.discreteFc")}</option>
            </select>
          </div>
        </div>
      </div>

      <div className="space-y-1">
        <label className="text-[color:var(--text-muted)]">{t("modbusUnitId.delayMs")}</label>
        <input
          type="number"
          min={0}
          max={5000}
          value={delayMs}
          onChange={(e) => setDelayMs(Math.max(0, Math.min(5000, Number(e.target.value) || 0)))}
          className={`w-20 px-2 py-1 rounded border border-[color:var(--border-default)] ${bgSurface} text-[color:var(--text-primary)]`}
        />
      </div>

      <p className="text-[color:var(--text-muted)] pt-2 border-t border-[color:var(--border-default)]">
        {t("modbusUnitId.scanDescription", {
          host: connection.host,
          port: connection.port,
          start: startUnitId,
          end: endUnitId,
          type: registerType,
          register: testRegister,
        })}
      </p>

      <button
        type="button"
        onClick={handleStart}
        disabled={!isValid}
        className={`flex items-center justify-center gap-2 w-full px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
          !isValid
            ? "bg-[var(--bg-surface)] text-[color:var(--text-muted)] cursor-not-allowed"
            : "bg-purple-600 hover:bg-purple-700 text-white"
        }`}
      >
        <Play className={iconMd} />
        {t("modbusUnitId.runScan")}
      </button>
    </div>
  );
}
