// ui/src/apps/catalog/views/protocol-editors/ModbusConfigSection.tsx

import { useTranslation } from "react-i18next";
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
  const { t } = useTranslation("catalog");
  return (
    <div className="space-y-4">
      {/* Frame Key (friendly name) - Required */}
      <div>
        <label className={`block ${textMedium} mb-2`}>
          {t("protocolEditors.modbusFrameNameLabel")} <span className="text-red-500">{t("protocolEditors.modbusFrameNameRequired")}</span>
        </label>
        <input
          type="text"
          value={frameKey}
          onChange={(e) => onFrameKeyChange(e.target.value)}
          className={`w-full px-4 py-2 bg-[var(--bg-surface)] border border-[color:var(--border-default)] rounded-lg text-[color:var(--text-primary)] ${focusRing}`}
          placeholder={t("protocolEditors.modbusFrameNamePlaceholder")}
        />
        <p className={`${caption} mt-1`}>
          {t("protocolEditors.modbusFrameNameHint")}
        </p>
      </div>

      {/* Register Number - Required */}
      <div>
        <label className={`block ${textMedium} mb-2`}>
          {t("protocolEditors.modbusRegisterNumberLabel")} <span className="text-red-500">{t("protocolEditors.modbusRegisterNumberRequired")}</span>
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
          placeholder={t("protocolEditors.modbusRegisterNumberPlaceholder")}
        />
        <p className={`${caption} mt-1`}>
          {t("protocolEditors.modbusRegisterNumberHint")}
        </p>
      </div>

      {/* Device Address - Required (but can be inherited) */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <label className={`block ${textMedium}`}>
            {t("protocolEditors.modbusDeviceAddressLabel")} <span className="text-red-500">{t("protocolEditors.modbusDeviceAddressRequired")}</span>
          </label>
          {defaultDeviceAddress !== undefined && onDeviceAddressInheritedChange && (
            <label className={`flex items-center gap-2 ${caption}`}>
              <input
                type="checkbox"
                checked={isDeviceAddressInherited ?? false}
                onChange={(e) => onDeviceAddressInheritedChange(e.target.checked)}
                className="w-3.5 h-3.5 rounded border-[color:var(--border-default)] text-[color:var(--accent-primary)] focus:ring-[color:var(--accent-primary)]"
              />
              {t("protocolEditors.modbusUseDefault", { value: defaultDeviceAddress })}
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
          placeholder={t("protocolEditors.modbusDeviceAddressPlaceholder")}
        />
        <p className={`${caption} mt-1`}>
          {t("protocolEditors.modbusDeviceAddressHint")}
        </p>
      </div>

      {/* Register Type */}
      <div>
        <label className={`block ${textMedium} mb-2`}>
          {t("protocolEditors.modbusRegisterTypeLabel")}
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
          <option value="holding">{t("protocolEditors.modbusRegisterTypeHolding")}</option>
          <option value="input">{t("protocolEditors.modbusRegisterTypeInput")}</option>
          <option value="coil">{t("protocolEditors.modbusRegisterTypeCoil")}</option>
          <option value="discrete">{t("protocolEditors.modbusRegisterTypeDiscrete")}</option>
        </select>
      </div>

      {/* Register Base - Optional (uses catalog default if not specified) */}
      <div>
        <label className={`block ${textMedium} mb-2`}>
          {t("protocolEditors.modbusRegisterBaseLabel")}
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
              ? t("protocolEditors.modbusRegisterBaseDefault", { base: defaultRegisterBase })
              : t("protocolEditors.modbusRegisterBaseNotSpecified")}
          </option>
          <option value="0">{t("protocolEditors.modbusRegisterBase0")}</option>
          <option value="1">{t("protocolEditors.modbusRegisterBase1")}</option>
        </select>
        <p className={`${caption} mt-1`}>
          {t("protocolEditors.modbusRegisterBaseHint")}
        </p>
      </div>
    </div>
  );
}
