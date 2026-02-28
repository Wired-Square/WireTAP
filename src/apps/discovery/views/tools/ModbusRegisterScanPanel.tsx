// ui/src/apps/discovery/views/tools/ModbusRegisterScanPanel.tsx

import { useState } from "react";
import { Play } from "lucide-react";
import { iconMd } from "../../../../styles/spacing";
import { bgSurface } from "../../../../styles";
import type { ModbusScanConfig, ModbusRegisterType } from "../../../../api/io";

type Props = {
  connection: { host: string; port: number; unit_id: number };
  onStartScan: (config: ModbusScanConfig) => void;
};

export default function ModbusRegisterScanPanel({ connection, onStartScan }: Props) {
  const [registerType, setRegisterType] = useState<ModbusRegisterType>("holding");
  const [unitId, setUnitId] = useState(connection.unit_id);
  const [startRegister, setStartRegister] = useState(0);
  const [endRegister, setEndRegister] = useState(999);
  const [chunkSize, setChunkSize] = useState(125);
  const [delayMs, setDelayMs] = useState(50);

  // Auto-adjust chunk size when register type changes
  const handleRegisterTypeChange = (type: ModbusRegisterType) => {
    setRegisterType(type);
    if (type === "coil" || type === "discrete") {
      setChunkSize(2000);
    } else {
      setChunkSize(125);
    }
  };

  const maxChunk = registerType === "coil" || registerType === "discrete" ? 2000 : 125;

  const handleStart = () => {
    onStartScan({
      host: connection.host,
      port: connection.port,
      unit_id: unitId,
      register_type: registerType,
      start_register: startRegister,
      end_register: endRegister,
      chunk_size: Math.min(chunkSize, maxChunk),
      inter_request_delay_ms: delayMs,
    });
  };

  const isValid = startRegister <= endRegister && chunkSize > 0;

  return (
    <div className="space-y-3 text-xs">
      <div className="flex gap-3">
        <div className="flex-1 space-y-1">
          <label className="text-[color:var(--text-muted)]">Register Type</label>
          <select
            value={registerType}
            onChange={(e) => handleRegisterTypeChange(e.target.value as ModbusRegisterType)}
            className={`w-full px-2 py-1 rounded border border-[color:var(--border-default)] ${bgSurface} text-[color:var(--text-primary)]`}
          >
            <option value="holding">Holding (FC 3)</option>
            <option value="input">Input (FC 4)</option>
            <option value="coil">Coil (FC 1)</option>
            <option value="discrete">Discrete (FC 2)</option>
          </select>
        </div>
        <div className="flex-1 space-y-1">
          <label className="text-[color:var(--text-muted)]">Unit ID</label>
          <input
            type="number"
            min={1}
            max={247}
            value={unitId}
            onChange={(e) => setUnitId(Math.max(1, Math.min(247, Number(e.target.value) || 1)))}
            className={`w-full px-2 py-1 rounded border border-[color:var(--border-default)] ${bgSurface} text-[color:var(--text-primary)]`}
          />
        </div>
      </div>

      <div className="flex gap-3">
        <div className="flex-1 space-y-1">
          <label className="text-[color:var(--text-muted)]">Start Register</label>
          <input
            type="number"
            min={0}
            max={65535}
            value={startRegister}
            onChange={(e) => setStartRegister(Math.max(0, Math.min(65535, Number(e.target.value) || 0)))}
            className={`w-full px-2 py-1 rounded border border-[color:var(--border-default)] ${bgSurface} text-[color:var(--text-primary)]`}
          />
        </div>
        <div className="flex-1 space-y-1">
          <label className="text-[color:var(--text-muted)]">End Register</label>
          <input
            type="number"
            min={0}
            max={65535}
            value={endRegister}
            onChange={(e) => setEndRegister(Math.max(0, Math.min(65535, Number(e.target.value) || 0)))}
            className={`w-full px-2 py-1 rounded border border-[color:var(--border-default)] ${bgSurface} text-[color:var(--text-primary)]`}
          />
        </div>
      </div>

      <div className="flex gap-3">
        <div className="flex-1 space-y-1">
          <label className="text-[color:var(--text-muted)]">Chunk Size</label>
          <input
            type="number"
            min={1}
            max={maxChunk}
            value={chunkSize}
            onChange={(e) => setChunkSize(Math.max(1, Math.min(maxChunk, Number(e.target.value) || 1)))}
            className={`w-full px-2 py-1 rounded border border-[color:var(--border-default)] ${bgSurface} text-[color:var(--text-primary)]`}
          />
        </div>
        <div className="flex-1 space-y-1">
          <label className="text-[color:var(--text-muted)]">Delay (ms)</label>
          <input
            type="number"
            min={0}
            max={5000}
            value={delayMs}
            onChange={(e) => setDelayMs(Math.max(0, Math.min(5000, Number(e.target.value) || 0)))}
            className={`w-full px-2 py-1 rounded border border-[color:var(--border-default)] ${bgSurface} text-[color:var(--text-primary)]`}
          />
        </div>
      </div>

      <p className="text-[color:var(--text-muted)] pt-2 border-t border-[color:var(--border-default)]">
        Scans {connection.host}:{connection.port} for {registerType} registers {startRegister}–{endRegister}.
        Discovered registers will appear in the frame picker.
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
        Run Scan
      </button>
    </div>
  );
}
