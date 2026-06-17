// ui/src/apps/catalog/views/protocol-editors/ModbusConfigSection.tsx

import { useTranslation } from "react-i18next";
import type { ModbusConfig, SlaveOption } from "../../types";
import { isRegisterKey, modbusNeedsRegisterNumber, MODBUS_REGISTER_REQUIRED_MESSAGE } from "../../protocols/modbus";
import { caption, textMedium, focusRing } from "../../../../styles";

export type ModbusConfigSectionProps = {
  config: ModbusConfig;
  onChange: (config: ModbusConfig) => void;
  /** The TOML key (friendly name) for this Modbus frame */
  frameKey: string;
  onFrameKeyChange: (key: string) => void;
  /** Declared slave nodes (name + address) the register can be attributed to. */
  availableSlaves: SlaveOption[];
  defaultRegisterBase?: 0 | 1;
};

export default function ModbusConfigSection({
  config,
  onChange,
  frameKey,
  onFrameKeyChange,
  availableSlaves,
  defaultRegisterBase,
}: ModbusConfigSectionProps) {
  const { t } = useTranslation("catalog");
  // The register comes from a numeric frame key OR an explicit register number.
  // A non-numeric name with no register number is incomplete — warn.
  const keyIsRegister = isRegisterKey(frameKey);
  const needsRegisterNumber = modbusNeedsRegisterNumber(frameKey, config);
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

      {/* Register Number — optional when the frame name is itself a register */}
      <div>
        <label className={`block ${textMedium} mb-2`}>
          {t("protocolEditors.modbusRegisterNumberLabel")}
        </label>
        <input
          type="number"
          min="0"
          max="65535"
          value={config.register_number ?? ""}
          onChange={(e) => {
            const v = e.target.value;
            const n = Number.parseInt(v, 10);
            onChange({ ...config, register_number: v === "" || Number.isNaN(n) ? undefined : n });
          }}
          className={`w-full px-4 py-2 bg-[var(--bg-surface)] border border-[color:var(--border-default)] rounded-lg text-[color:var(--text-primary)] ${focusRing}`}
          placeholder={keyIsRegister ? `${parseInt(frameKey)} (from name)` : t("protocolEditors.modbusRegisterNumberPlaceholder")}
        />
        {needsRegisterNumber ? (
          <p className="mt-1 text-xs text-[color:var(--text-amber)]">
            ⚠ {MODBUS_REGISTER_REQUIRED_MESSAGE}
          </p>
        ) : (
          <p className={`${caption} mt-1`}>
            {keyIsRegister
              ? "Optional — taken from the frame name. Set a value only to override it."
              : t("protocolEditors.modbusRegisterNumberHint")}
          </p>
        )}
      </div>

      {/* Slave - the node that owns the device address */}
      <div>
        <label className={`block ${textMedium} mb-2`}>
          {t("protocolEditors.modbusSlaveLabel")}
        </label>
        <select
          value={config.node_address ?? ""}
          onChange={(e) =>
            onChange({ ...config, node_address: e.target.value === "" ? undefined : Number(e.target.value) })
          }
          className={`w-full px-4 py-2 bg-[var(--bg-surface)] border border-[color:var(--border-default)] rounded-lg text-[color:var(--text-primary)] ${focusRing}`}
        >
          <option value="">{t("protocolEditors.modbusSlaveNone")}</option>
          {availableSlaves.map((slave) => (
            <option key={slave.address} value={slave.address}>
              {slave.name} (#{slave.address})
            </option>
          ))}
        </select>
        <p className={`${caption} mt-1`}>
          {t("protocolEditors.modbusSlaveHint")}
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
