// ui/src/apps/catalog/views/protocol-editors/ModbusConfigSection.tsx

import { useTranslation } from "react-i18next";
import type { ModbusConfig, SlaveOption } from "../../types";
import { parseCanIdToNumber } from "../../utils";
import { caption, textMedium } from "../../../../styles";
import { Input, Select } from "../../../../components/forms";

export type ModbusConfigSectionProps = {
  config: ModbusConfig;
  onChange: (config: ModbusConfig) => void;
  /** The TOML key (friendly name) for this Modbus frame */
  frameKey: string;
  onFrameKeyChange: (key: string) => void;
  /** Declared slave nodes (name + address) the register can be attributed to. */
  availableSlaves: SlaveOption[];
};

export default function ModbusConfigSection({
  config,
  onChange,
  frameKey,
  onFrameKeyChange,
  availableSlaves,
}: ModbusConfigSectionProps) {
  const { t } = useTranslation("catalog");
  // The register comes from a numeric frame key OR an explicit register number.
  // A non-numeric name with no register number is incomplete — warn.
  const keyIsRegister = parseCanIdToNumber(frameKey) !== null;
  const needsRegisterNumber = !keyIsRegister && config.register_number == null;
  return (
    <div className="space-y-4">
      {/* Frame Key (friendly name) - Required */}
      <div>
        <label className={`block ${textMedium} mb-2`}>
          {t("protocolEditors.modbusFrameNameLabel")} <span className="text-danger">{t("protocolEditors.modbusFrameNameRequired")}</span>
        </label>
        <Input
          type="text"
          value={frameKey}
          onChange={(e) => onFrameKeyChange(e.target.value)}
          size="lg"
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
        <Input
          type="number"
          min="0"
          max="65535"
          value={config.register_number ?? ""}
          onChange={(e) => {
            const v = e.target.value;
            const n = Number.parseInt(v, 10);
            onChange({ ...config, register_number: v === "" || Number.isNaN(n) ? undefined : n });
          }}
          size="lg"
          placeholder={keyIsRegister ? `${parseInt(frameKey)} (from name)` : t("protocolEditors.modbusRegisterNumberPlaceholder")}
        />
        {needsRegisterNumber ? (
          <p className="mt-1 text-xs text-amber">
            ⚠ Name isn't a register — enter a register number, or name the frame by its register (e.g. 2581 or 0x32F9).
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
        <Select
          value={config.node_address ?? ""}
          onChange={(e) =>
            onChange({ ...config, node_address: e.target.value === "" ? undefined : Number(e.target.value) })
          }
          size="lg"
        >
          <option value="">{t("protocolEditors.modbusSlaveNone")}</option>
          {availableSlaves.map((slave) => (
            <option key={slave.address} value={slave.address}>
              {slave.name} (#{slave.address})
            </option>
          ))}
        </Select>
        <p className={`${caption} mt-1`}>
          {t("protocolEditors.modbusSlaveHint")}
        </p>
      </div>

      {/* Register Type */}
      <div>
        <label className={`block ${textMedium} mb-2`}>
          {t("protocolEditors.modbusRegisterTypeLabel")}
        </label>
        <Select
          value={config.register_type ?? "holding"}
          onChange={(e) =>
            onChange({
              ...config,
              register_type: e.target.value as ModbusConfig["register_type"],
            })
          }
          size="lg"
        >
          <option value="holding">{t("protocolEditors.modbusRegisterTypeHolding")}</option>
          <option value="input">{t("protocolEditors.modbusRegisterTypeInput")}</option>
          <option value="coil">{t("protocolEditors.modbusRegisterTypeCoil")}</option>
          <option value="discrete">{t("protocolEditors.modbusRegisterTypeDiscrete")}</option>
        </Select>
      </div>
    </div>
  );
}
