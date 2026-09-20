// ui/src/apps/catalog/views/FrameEditView.tsx
// Generic frame editor that handles CAN, Modbus, and Serial protocols

import { useMemo, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { Network, Server, Cable } from "lucide-react";
import { iconMd, iconLg } from "../../../styles/spacing";
import { caption, textMedium } from "../../../styles";
import type {
  ProtocolType,
  ProtocolConfig,
  CANConfig,
  ModbusConfig,
  SerialConfig,
  BaseFrameFields,
  SlaveOption,
} from "../types";
import { protocolRegistry } from "../protocols";
import { CANConfigSection, ModbusConfigSection, SerialConfigSection } from "./protocol-editors";
import { SecondaryButton, PrimaryButton, Input, Select, Checkbox, Textarea } from "../../../components/forms";

// Icon mapping for protocols
const protocolIcons: Record<ProtocolType, React.ComponentType<{ className?: string }>> = {
  can: Network,
  modbus: Server,
  serial: Cable,
};

export interface FrameEditFields {
  protocol: ProtocolType;
  config: ProtocolConfig;
  base: BaseFrameFields;
  // For Modbus, we need a separate key since it's not derived from config
  modbusFrameKey?: string;
  // Inheritance flags
  isLengthInherited?: boolean;
  isTransmitterInherited?: boolean;
  isIntervalInherited?: boolean;
}

export type FrameEditViewProps = {
  title?: string;
  subtitle?: string;

  fields: FrameEditFields;
  setFields: (fields: FrameEditFields) => void;

  availablePeers: string[];
  /** Declared slave nodes (name + address) for the Modbus Slave picker. */
  availableSlaves: SlaveOption[];

  /** Whether to allow changing the protocol (only for new frames) */
  allowProtocolChange?: boolean;

  /** Default values from catalog meta */
  defaults?: {
    interval?: number;
    modbusDeviceAddress?: number;
    modbusRegisterBase?: 0 | 1;
    serialEncoding?: "slip" | "cobs" | "raw" | "length_prefixed";
  };

  primaryActionLabel?: string;
  onCancel: () => void;
  onSave: () => void;

  disableSave?: boolean;
};

export default function FrameEditView({
  title,
  subtitle,
  fields,
  setFields,
  availablePeers,
  availableSlaves,
  allowProtocolChange = true,
  defaults,
  primaryActionLabel,
  onCancel,
  onSave,
  disableSave,
}: FrameEditViewProps) {
  const { t } = useTranslation("catalog");
  const resolvedTitle = title ?? t("frameEditView.addTitle");
  const resolvedSubtitle = subtitle ?? t("frameEditView.addSubtitle");
  const resolvedAction = primaryActionLabel ?? t("frameEditView.addButton");
  // Get registered protocols
  const protocols = useMemo(() => protocolRegistry.all(), []);

  // Handle protocol change
  const handleProtocolChange = useCallback(
    (newProtocol: ProtocolType) => {
      const handler = protocolRegistry.get(newProtocol);
      if (!handler) return;

      const config = handler.getDefaultConfig();
      // NOTE: For serial, encoding is NOT in config - it's catalog-level in [frame.serial.config]

      setFields({
        ...fields,
        protocol: newProtocol,
        config,
        modbusFrameKey: newProtocol === "modbus" ? "" : undefined,
      });
    },
    [fields, setFields]
  );

  // Protocol-specific config updates
  const handleCANConfigChange = useCallback(
    (config: CANConfig) => {
      setFields({ ...fields, config });
    },
    [fields, setFields]
  );

  const handleModbusConfigChange = useCallback(
    (config: ModbusConfig) => {
      setFields({ ...fields, config });
    },
    [fields, setFields]
  );

  const handleModbusKeyChange = useCallback(
    (key: string) => {
      setFields({ ...fields, modbusFrameKey: key });
    },
    [fields, setFields]
  );

  const handleSerialConfigChange = useCallback(
    (config: SerialConfig) => {
      setFields({ ...fields, config });
    },
    [fields, setFields]
  );

  // Base fields updates
  const handleBaseChange = useCallback(
    (updates: Partial<BaseFrameFields>) => {
      setFields({
        ...fields,
        base: { ...fields.base, ...updates },
      });
    },
    [fields, setFields]
  );

  // Inheritance flag updates
  const handleInheritanceChange = useCallback(
    (flag: keyof Pick<FrameEditFields, "isLengthInherited" | "isTransmitterInherited" | "isIntervalInherited">, value: boolean) => {
      setFields({ ...fields, [flag]: value });
    },
    [fields, setFields]
  );

  // Render protocol-specific config section
  const renderProtocolConfig = () => {
    switch (fields.protocol) {
      case "can":
        return (
          <CANConfigSection
            config={fields.config as CANConfig}
            onChange={handleCANConfigChange}
          />
        );
      case "modbus":
        return (
          <ModbusConfigSection
            config={fields.config as ModbusConfig}
            onChange={handleModbusConfigChange}
            frameKey={fields.modbusFrameKey ?? ""}
            onFrameKeyChange={handleModbusKeyChange}
            availableSlaves={availableSlaves}
            defaultRegisterBase={defaults?.modbusRegisterBase}
          />
        );
      case "serial":
        return (
          <SerialConfigSection
            config={fields.config as SerialConfig}
            onChange={handleSerialConfigChange}
            catalogEncoding={defaults?.serialEncoding}
          />
        );
      default:
        return null;
    }
  };

  // Get current handler for display info
  const currentHandler = protocolRegistry.get(fields.protocol);

  return (
    <div className="max-w-4xl">
      <div className="mb-6">
        <h2 className="text-2xl font-bold text-primary mb-2">{resolvedTitle}</h2>
        <p className="text-sm text-muted">{resolvedSubtitle}</p>
      </div>

      <div className="space-y-6">
        {/* Protocol Selector (only for new frames) */}
        {allowProtocolChange && (
          <div>
            <label className={`block ${textMedium} mb-3`}>
              {t("frameEditView.protocolLabel")}
            </label>
            <div className="grid grid-cols-3 gap-3">
              {protocols.map((handler) => {
                const Icon = protocolIcons[handler.type];
                const isSelected = fields.protocol === handler.type;
                return (
                  <button
                    key={handler.type}
                    type="button"
                    onClick={() => handleProtocolChange(handler.type)}
                    className={`flex items-center gap-3 p-4 rounded-lg border-2 transition-colors ${
                      isSelected
                        ? "border-accent-primary bg-info"
                        : "border-default hover:border-hover"
                    }`}
                  >
                    <Icon
                      className={`${iconLg} ${
                        isSelected ? "text-accent-primary" : "text-muted"
                      }`}
                    />
                    <span
                      className={`font-medium ${
                        isSelected ? "text-info" : "text-secondary"
                      }`}
                    >
                      {handler.displayName}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* Protocol-Specific Configuration */}
        <div className="p-4 bg-surface rounded-lg">
          <h3 className="text-sm font-semibold text-secondary mb-4 flex items-center gap-2">
            {currentHandler && (
              <>
                {(() => {
                  const Icon = protocolIcons[currentHandler.type];
                  return <Icon className={iconMd} />;
                })()}
                {currentHandler.displayName} {t("frameEditView.configurationSuffix")}
              </>
            )}
          </h3>
          {renderProtocolConfig()}
        </div>

        {/* Common Frame Fields */}
        <div className="p-4 bg-surface rounded-lg">
          <h3 className="text-sm font-semibold text-secondary mb-4">
            {t("frameEditView.commonProperties")}
          </h3>

          <div className="space-y-4">
            {/* Length (DLC) */}
            <div>
              <label className={`block ${textMedium} mb-2`}>
                {t("frameEditView.lengthLabel")} {fields.protocol === "can" && t("frameEditView.lengthDlcSuffix")}{" "}
                {fields.protocol === "modbus" && t("frameEditView.lengthRegistersSuffix")}
              </label>
              <Input
                type="number"
                min="0"
                max={fields.protocol === "can" ? 64 : 256}
                value={fields.base.length}
                onChange={(e) => handleBaseChange({ length: parseInt(e.target.value) || 0 })}
                size="lg"
              />
            </div>

            {/* Transmitter (Peer) — Modbus uses the per-register Slave instead. */}
            {fields.protocol !== "modbus" && (
              <div>
                <label className={`block ${textMedium} mb-2`}>
                  {t("frameEditView.transmitterLabel")}
                </label>
                <Select
                  value={fields.base.transmitter || ""}
                  onChange={(e) => handleBaseChange({ transmitter: e.target.value || undefined })}
                  size="lg"
                >
                  <option value="">{t("frameEditView.transmitterNone")}</option>
                  {availablePeers.map((peer) => (
                    <option key={peer} value={peer}>
                      {peer}
                    </option>
                  ))}
                </Select>
              </div>
            )}

            {/* Interval (ms) */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <label className={`block ${textMedium}`}>
                  {t("frameEditView.intervalLabel")}
                </label>
                {defaults?.interval !== undefined && (
                  <label className={`flex items-center gap-2 ${caption}`}>
                    <Checkbox
                      checked={fields.isIntervalInherited ?? false}
                      onChange={(e) => handleInheritanceChange("isIntervalInherited", e.target.checked)}
                      size="sm"
                    />
                    {t("frameEditView.useDefault", { value: defaults.interval })}
                  </label>
                )}
              </div>
              <Input
                type="number"
                min="0"
                value={fields.base.interval ?? ""}
                onChange={(e) =>
                  handleBaseChange({
                    interval: e.target.value ? parseInt(e.target.value) : undefined,
                  })
                }
                disabled={fields.isIntervalInherited}
                size="lg"
                placeholder={t("frameEditView.intervalPlaceholder")}
              />
            </div>

            {/* Notes */}
            <div>
              <label className={`block ${textMedium} mb-2`}>
                {t("frameEditView.notesLabel")}
              </label>
              <Textarea
                rows={3}
                value={
                  Array.isArray(fields.base.notes)
                    ? fields.base.notes.join("\n")
                    : fields.base.notes || ""
                }
                onChange={(e) => {
                  const value = e.target.value;
                  if (!value) {
                    handleBaseChange({ notes: undefined });
                  } else {
                    const lines = value.split("\n");
                    handleBaseChange({
                      notes: lines.length === 1 ? lines[0] : lines,
                    });
                  }
                }}
                size="lg"
                mono
                placeholder={t("frameEditView.notesPlaceholder")}
              />
            </div>
          </div>
        </div>

        {/* Actions */}
        <div className="flex justify-end gap-3 pt-4">
          <SecondaryButton
            onClick={onCancel}
          >
            {t("frameEditView.cancel")}
          </SecondaryButton>
          <PrimaryButton
            onClick={onSave}
            disabled={disableSave}
          >
            {resolvedAction}
          </PrimaryButton>
        </div>
      </div>
    </div>
  );
}
