// ui/src/apps/catalog/views/protocol-editors/ModbusConfigSection.tsx

import type { ModbusConfig } from "../../types";
import { caption, textMedium, focusRing } from "../../../../styles";

export type ModbusConfigSectionProps = {
  config: ModbusConfig;
  onChange: (config: ModbusConfig) => void;
  /** The TOML key (friendly name) for this Modbus frame */
  frameKey: string;
  onFrameKeyChange: (key: string) => void;
  isDeviceAddressInherited?: boolean;
  onDeviceAddressInheritedChange?: (inherited: boolean) => void;
  defaultDeviceAddress?: number;
  defaultRegisterBase?: 0 | 1;
};

export default function ModbusConfigSection({
  config,
  onChange,
  frameKey,
  onFrameKeyChange,
  isDeviceAddressInherited,
  onDeviceAddressInheritedChange,
  defaultDeviceAddress,
  defaultRegisterBase,
}: ModbusConfigSectionProps) {
  return (
    <div className="space-y-4">
      {/* Frame Key (friendly name) - Required */}
      <div>
        <label className={`block ${textMedium} mb-2`}>
          Frame Name <span className="text-red-500">*</span>
        </label>
        <input
          type="text"
          value={frameKey}
          onChange={(e) => onFrameKeyChange(e.target.value)}
          className={`w-full px-4 py-2 bg-[var(--bg-surface)] border border-[color:var(--border-default)] rounded-lg text-[color:var(--text-primary)] ${focusRing}`}
          placeholder="battery_voltage"
        />
        <p className={`${caption} mt-1`}>
          A descriptive name for this register group
        </p>
      </div>

      {/* Register Number - Required */}
      <div>
        <label className={`block ${textMedium} mb-2`}>
          Register Number <span className="text-red-500">*</span>
        </label>
        <input
          type="number"
          min="0"
          max="65535"
          value={config.register_number}
          onChange={(e) =>
            onChange({ ...config, register_number: parseInt(e.target.value) || 0 })
          }
          className={`w-full px-4 py-2 bg-[var(--bg-surface)] border border-[color:var(--border-default)] rounded-lg text-[color:var(--text-primary)] ${focusRing}`}
          placeholder="100"
        />
        <p className={`${caption} mt-1`}>
          Starting register address (0-65535)
        </p>
      </div>

      {/* Device Address - Required (but can be inherited) */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <label className={`block ${textMedium}`}>
            Device Address <span className="text-red-500">*</span>
          </label>
          {defaultDeviceAddress !== undefined && onDeviceAddressInheritedChange && (
            <label className={`flex items-center gap-2 ${caption}`}>
              <input
                type="checkbox"
                checked={isDeviceAddressInherited ?? false}
                onChange={(e) => onDeviceAddressInheritedChange(e.target.checked)}
                className="w-3.5 h-3.5 rounded border-[color:var(--border-default)] text-[color:var(--accent-primary)] focus:ring-blue-500"
              />
              Use default ({defaultDeviceAddress})
            </label>
          )}
        </div>
        <input
          type="number"
          min="1"
          max="247"
          value={config.device_address}
          onChange={(e) =>
            onChange({ ...config, device_address: parseInt(e.target.value) || 1 })
          }
          disabled={isDeviceAddressInherited}
          className={`w-full px-4 py-2 bg-[var(--bg-surface)] border border-[color:var(--border-default)] rounded-lg text-[color:var(--text-primary)] ${focusRing} ${
            isDeviceAddressInherited ? "opacity-50 cursor-not-allowed" : ""
          }`}
          placeholder="1"
        />
        <p className={`${caption} mt-1`}>
          Modbus slave address (1-247)
        </p>
      </div>

      {/* Register Type */}
      <div>
        <label className={`block ${textMedium} mb-2`}>
          Register Type
        </label>
        <select
          value={config.register_type ?? "holding"}
          onChange={(e) =>
            onChange({
              ...config,
              register_type: e.target.value as ModbusConfig["register_type"],
            })
          }
          className={`w-full px-4 py-2 bg-[var(--bg-surface)] border border-[color:var(--border-default)] rounded-lg text-[color:var(--text-primary)] ${focusRing}`}
        >
          <option value="holding">Holding Registers (FC 03/06/16)</option>
          <option value="input">Input Registers (FC 04)</option>
          <option value="coil">Coils (FC 01/05/15)</option>
          <option value="discrete">Discrete Inputs (FC 02)</option>
        </select>
      </div>

      {/* Register Base - Optional (uses catalog default if not specified) */}
      <div>
        <label className={`block ${textMedium} mb-2`}>
          Register Base
        </label>
        <select
          value={config.register_base ?? ""}
          onChange={(e) =>
            onChange({
              ...config,
              register_base: e.target.value === "" ? undefined : (parseInt(e.target.value) as 0 | 1),
            })
          }
          className={`w-full px-4 py-2 bg-[var(--bg-surface)] border border-[color:var(--border-default)] rounded-lg text-[color:var(--text-primary)] ${focusRing}`}
        >
          <option value="">
            {defaultRegisterBase !== undefined
              ? `Use default (${defaultRegisterBase}-based)`
              : "Not specified"}
          </option>
          <option value="0">0-based (0-65535)</option>
          <option value="1">1-based (1-65536)</option>
        </select>
        <p className={`${caption} mt-1`}>
          Some manufacturers count registers from 0, others from 1
        </p>
      </div>
    </div>
  );
}
