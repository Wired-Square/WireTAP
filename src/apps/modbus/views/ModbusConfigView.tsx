// ui/src/apps/modbus/views/ModbusConfigView.tsx
//
// Configuration panel for Modbus transport mode and RTU settings.

import { Wifi, Cable } from "lucide-react";
import { inputSimple, labelSmall, helpText, bgDataView, textPrimary, textMuted, borderDefault } from "../../../styles";
import type { ModbusTransportMode, ModbusRtuConfig } from "../stores/modbusStore";
import type { ModbusProtocolConfig } from "../../../utils/catalogParser";

interface Props {
  transportMode: ModbusTransportMode;
  rtuConfig: ModbusRtuConfig;
  modbusConfig: ModbusProtocolConfig | null;
  onSetTransportMode: (mode: ModbusTransportMode) => void;
  onSetRtuConfig: (config: Partial<ModbusRtuConfig>) => void;
}

export default function ModbusConfigView({
  transportMode,
  rtuConfig,
  modbusConfig,
  onSetTransportMode,
  onSetRtuConfig,
}: Props) {
  return (
    <div className={`h-full overflow-auto p-4 space-y-6 ${bgDataView}`}>
      {/* Transport mode */}
      <section className="space-y-2">
        <h3 className={labelSmall}>Transport Mode</h3>
        <div className="flex gap-2">
          <button
            onClick={() => onSetTransportMode('tcp')}
            className={`flex items-center gap-2 px-3 py-2 rounded-lg border text-sm transition-colors ${
              transportMode === 'tcp'
                ? 'border-blue-500 bg-blue-500/10 text-[color:var(--text-blue)]'
                : `border-[color:var(--border-default)] ${textMuted} hover:border-[color:var(--border-hover)]`
            }`}
          >
            <Wifi size={16} />
            Modbus TCP
          </button>
          <button
            onClick={() => onSetTransportMode('rtu')}
            className={`flex items-center gap-2 px-3 py-2 rounded-lg border text-sm transition-colors ${
              transportMode === 'rtu'
                ? 'border-orange-500 bg-orange-500/10 text-[color:var(--text-orange)]'
                : `border-[color:var(--border-default)] ${textMuted} hover:border-[color:var(--border-hover)]`
            }`}
          >
            <Cable size={16} />
            Modbus RTU
          </button>
        </div>
      </section>

      {/* RTU settings (only shown when RTU mode is selected) */}
      {transportMode === 'rtu' && (
        <section className="space-y-3">
          <h3 className={labelSmall}>RTU Settings</h3>
          <div className="grid grid-cols-2 gap-3 max-w-md">
            <div>
              <label className={`block mb-1 ${helpText}`}>Device Address (1-247)</label>
              <input
                type="number"
                min={1}
                max={247}
                value={rtuConfig.deviceAddress}
                onChange={(e) => onSetRtuConfig({ deviceAddress: Math.max(1, Math.min(247, Number(e.target.value))) })}
                className={inputSimple}
              />
            </div>
            <div>
              <label className={`block mb-1 ${helpText}`}>Response Timeout (ms)</label>
              <input
                type="number"
                min={100}
                max={10000}
                value={rtuConfig.responseTimeoutMs}
                onChange={(e) => onSetRtuConfig({ responseTimeoutMs: Number(e.target.value) })}
                className={inputSimple}
              />
            </div>
            <div>
              <label className={`block mb-1 ${helpText}`}>Inter-Request Delay (ms)</label>
              <input
                type="number"
                min={0}
                max={5000}
                value={rtuConfig.interRequestDelayMs}
                onChange={(e) => onSetRtuConfig({ interRequestDelayMs: Number(e.target.value) })}
                className={inputSimple}
              />
            </div>
            <div className="flex items-end">
              <label className="flex items-center gap-2 text-xs">
                <input
                  type="checkbox"
                  checked={rtuConfig.validateCrc}
                  onChange={(e) => onSetRtuConfig({ validateCrc: e.target.checked })}
                  className="w-3 h-3"
                />
                <span className={textPrimary}>Validate CRC</span>
              </label>
            </div>
          </div>
        </section>
      )}

      {/* Catalogue info */}
      {modbusConfig && (
        <section className={`space-y-2 p-3 rounded-lg border ${borderDefault}`}>
          <h3 className={labelSmall}>Catalogue Configuration</h3>
          <div className={`grid grid-cols-2 gap-2 text-xs ${textMuted}`}>
            {modbusConfig.device_address !== undefined && (
              <>
                <span>Device Address</span>
                <span className={textPrimary}>{modbusConfig.device_address}</span>
              </>
            )}
            {modbusConfig.register_base !== undefined && (
              <>
                <span>Register Base</span>
                <span className={textPrimary}>{modbusConfig.register_base === 0 ? '0 (IEC)' : '1 (Traditional)'}</span>
              </>
            )}
            {modbusConfig.default_interval !== undefined && (
              <>
                <span>Default Interval</span>
                <span className={textPrimary}>{(modbusConfig.default_interval / 1000).toFixed(1)}s</span>
              </>
            )}
            {modbusConfig.default_byte_order && (
              <>
                <span>Byte Order</span>
                <span className={textPrimary}>{modbusConfig.default_byte_order}</span>
              </>
            )}
            {modbusConfig.default_word_order && (
              <>
                <span>Word Order</span>
                <span className={textPrimary}>{modbusConfig.default_word_order}</span>
              </>
            )}
          </div>
        </section>
      )}
    </div>
  );
}
