// ui/src/apps/catalog/dialogs/config-sections/ModbusConfigSection.tsx
// Modbus protocol configuration section for unified config dialog

import { Network, ChevronDown, ChevronRight, AlertTriangle, Check } from "lucide-react";
import { iconMd, iconXs, flexRowGap2 } from "../../../../styles/spacing";
import { caption, textMedium } from "../../../../styles/typography";
import { expandableRowContainer } from "../../../../styles";
import { Button } from "../../../../components/Button";
import { Select, Input } from "../../../../components/forms";
import { Card } from "../../../../components/Card";
export type ModbusConfigSectionProps = {
  isConfigured: boolean;
  hasFrames: boolean;
  isExpanded: boolean;
  onToggleExpanded: () => void;
  onAdd: () => void;
  onRemove: () => void;
  // Config values (only used when configured). The device (slave) address lives
  // on each slave node, not here.
  registerBase: 0 | 1;
  setRegisterBase: (base: 0 | 1) => void;
  defaultInterval: number | undefined;
  setDefaultInterval: (interval: number | undefined) => void;
  defaultByteOrder: "big" | "little";
  setDefaultByteOrder: (order: "big" | "little") => void;
  defaultWordOrder: "big" | "little";
  setDefaultWordOrder: (order: "big" | "little") => void;
};

export default function ModbusConfigSection({
  isConfigured,
  hasFrames,
  isExpanded,
  onToggleExpanded,
  onAdd,
  onRemove,
  registerBase,
  setRegisterBase,
  defaultInterval,
  setDefaultInterval,
  defaultByteOrder,
  setDefaultByteOrder,
  defaultWordOrder,
  setDefaultWordOrder,
}: ModbusConfigSectionProps) {
  // Status indicator
  const showWarning = hasFrames && !isConfigured;

  return (
    <Card padding="none" className="overflow-hidden">
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
            <Button
              onClick={onRemove}
              variant="ghost"
              tone="danger"
              size="sm"
            >
              Remove
            </Button>
          ) : (
            <Button
              onClick={onAdd}
              variant="ghost"
              tone="warning"
              size="sm"
            >
              + Add
            </Button>
          )}
        </div>
      </div>

      {/* Content */}
      {isExpanded && isConfigured && (
        <div className="p-4 space-y-4 border-t border-[color:var(--border-default)]">
          {/* Register Base */}
          <div>
            <label className={`block ${textMedium} mb-2`}>
              Register Base <span className="text-red-500">*</span>
            </label>
            <Select
              value={registerBase}
              onChange={(e) => setRegisterBase(parseInt(e.target.value) as 0 | 1)}
              size="lg"
            >
              <option value={0}>0-based (register 0 = address 0)</option>
              <option value={1}>1-based (register 1 = address 0)</option>
            </Select>
            <p className={`mt-1 ${caption}`}>
              Register addressing convention used by the device
            </p>
          </div>

          {/* Default Poll Interval */}
          <div>
            <label className={`block ${textMedium} mb-2`}>
              Default Poll Interval
            </label>
            <div className="flex items-center gap-2">
              <Input
                type="number"
                min={100}
                max={3600000}
                value={defaultInterval ?? ""}
                placeholder="1000"
                onChange={(e) => {
                  const val = e.target.value === "" ? undefined : parseInt(e.target.value);
                  setDefaultInterval(val !== undefined && !isNaN(val) ? val : undefined);
                }}
                size="lg"
              />
              <span className="text-sm text-[color:var(--text-muted)] whitespace-nowrap">ms</span>
            </div>
            <p className={`mt-1 ${caption}`}>
              Default polling interval for frames without an explicit interval
            </p>
          </div>

          {/* Byte Order & Word Order */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className={`block ${textMedium} mb-2`}>
                Default Byte Order
              </label>
              <Select
                value={defaultByteOrder}
                onChange={(e) => setDefaultByteOrder(e.target.value as "big" | "little")}
                size="lg"
              >
                <option value="big">Big-endian</option>
                <option value="little">Little-endian</option>
              </Select>
              <p className={`mt-1 ${caption}`}>
                Byte order within each register
              </p>
            </div>

            <div>
              <label className={`block ${textMedium} mb-2`}>
                Default Word Order
              </label>
              <Select
                value={defaultWordOrder}
                onChange={(e) => setDefaultWordOrder(e.target.value as "big" | "little")}
                size="lg"
              >
                <option value="big">Big-endian (high word first)</option>
                <option value="little">Little-endian (low word first)</option>
              </Select>
              <p className={`mt-1 ${caption}`}>
                Word order for multi-register values
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Collapsed preview when configured but not expanded */}
      {!isExpanded && isConfigured && (
        <div className={`px-4 py-2 ${caption} border-t border-[color:var(--border-default)]`}>
          Base: {registerBase}-based
          {defaultInterval !== undefined && ` • ${defaultInterval}ms`}
          {` • Byte: ${defaultByteOrder === "big" ? "BE" : "LE"}`}
          {` • Word: ${defaultWordOrder === "big" ? "BE" : "LE"}`}
        </div>
      )}
    </Card>
  );
}
