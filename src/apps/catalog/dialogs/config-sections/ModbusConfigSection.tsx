// ui/src/apps/catalog/dialogs/config-sections/ModbusConfigSection.tsx
// Modbus protocol configuration section for unified config dialog

import { Network, ChevronDown, ChevronRight, AlertTriangle, Check } from "lucide-react";
import { iconMd, iconXs, flexRowGap2 } from "../../../../styles/spacing";
import { caption, textMedium } from "../../../../styles/typography";
import { focusRing, expandableRowContainer } from "../../../../styles";

export type ModbusConfigSectionProps = {
  isConfigured: boolean;
  hasFrames: boolean;
  isExpanded: boolean;
  onToggleExpanded: () => void;
  onAdd: () => void;
  onRemove: () => void;
  // Config values (only used when configured)
  deviceAddress: number;
  setDeviceAddress: (address: number) => void;
  registerBase: 0 | 1;
  setRegisterBase: (base: 0 | 1) => void;
};

export default function ModbusConfigSection({
  isConfigured,
  hasFrames,
  isExpanded,
  onToggleExpanded,
  onAdd,
  onRemove,
  deviceAddress,
  setDeviceAddress,
  registerBase,
  setRegisterBase,
}: ModbusConfigSectionProps) {
  // Status indicator
  const showWarning = hasFrames && !isConfigured;
  const isValid = deviceAddress >= 1 && deviceAddress <= 247;

  return (
    <div className="border border-[color:var(--border-default)] rounded-lg overflow-hidden">
      {/* Header */}
      <div
        role="button"
        tabIndex={0}
        onClick={onToggleExpanded}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') onToggleExpanded(); }}
        className={expandableRowContainer}
      >
        <div className="flex items-center gap-3">
          {isExpanded ? (
            <ChevronDown className={`${iconMd} text-slate-500`} />
          ) : (
            <ChevronRight className={`${iconMd} text-slate-500`} />
          )}
          <div className="p-1.5 bg-[var(--status-warning-bg)] rounded">
            <Network className={`${iconMd} text-[color:var(--text-amber)]`} />
          </div>
          <span className="font-medium text-[color:var(--text-primary)]">Modbus</span>
          {isConfigured && (
            <span className="flex items-center gap-1 text-xs text-[color:var(--text-green)]">
              <Check className={iconXs} />
              configured
            </span>
          )}
          {showWarning && (
            <span className="flex items-center gap-1 text-xs text-[color:var(--text-amber)]">
              <AlertTriangle className={iconXs} />
              frames exist, no config
            </span>
          )}
        </div>
        <div className={flexRowGap2} onClick={(e) => e.stopPropagation()}>
          {isConfigured ? (
            <button
              type="button"
              onClick={onRemove}
              className="px-2 py-1 text-xs text-[color:var(--text-red)] hover:bg-[var(--status-danger-bg)] rounded transition-colors"
            >
              Remove
            </button>
          ) : (
            <button
              type="button"
              onClick={onAdd}
              className="px-2 py-1 text-xs text-[color:var(--text-amber)] hover:bg-[var(--status-warning-bg)] rounded transition-colors"
            >
              + Add
            </button>
          )}
        </div>
      </div>

      {/* Content */}
      {isExpanded && isConfigured && (
        <div className="p-4 space-y-4 border-t border-[color:var(--border-default)]">
          {/* Device Address */}
          <div>
            <label className={`block ${textMedium} mb-2`}>
              Device Address <span className="text-red-500">*</span>
            </label>
            <input
              type="number"
              min={1}
              max={247}
              value={deviceAddress}
              onChange={(e) => {
                const val = parseInt(e.target.value);
                if (!isNaN(val)) setDeviceAddress(val);
              }}
              className={`w-full px-4 py-2 border rounded-lg text-[color:var(--text-primary)] ${focusRing} ${
                !isValid
                  ? "bg-[var(--status-danger-bg)] border-[color:var(--status-danger-border)]"
                  : "bg-[var(--bg-surface)] border-[color:var(--border-default)]"
              }`}
            />
            <p className={`mt-1 ${caption}`}>
              Modbus slave address (1-247)
            </p>
          </div>

          {/* Register Base */}
          <div>
            <label className={`block ${textMedium} mb-2`}>
              Register Base <span className="text-red-500">*</span>
            </label>
            <select
              value={registerBase}
              onChange={(e) => setRegisterBase(parseInt(e.target.value) as 0 | 1)}
              className={`w-full px-4 py-2 bg-[var(--bg-surface)] border border-[color:var(--border-default)] rounded-lg text-[color:var(--text-primary)] ${focusRing}`}
            >
              <option value={0}>0-based (register 0 = address 0)</option>
              <option value={1}>1-based (register 1 = address 0)</option>
            </select>
            <p className={`mt-1 ${caption}`}>
              Register addressing convention used by the device
            </p>
          </div>
        </div>
      )}

      {/* Collapsed preview when configured but not expanded */}
      {!isExpanded && isConfigured && (
        <div className={`px-4 py-2 ${caption} border-t border-[color:var(--border-default)]`}>
          Address: {deviceAddress} • Base: {registerBase}-based
        </div>
      )}
    </div>
  );
}
