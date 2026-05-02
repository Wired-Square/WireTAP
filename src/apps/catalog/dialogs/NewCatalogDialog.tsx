// ui/src/apps/catalog/dialogs/NewCatalogDialog.tsx

import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Network, Server, Cable } from "lucide-react";
import { iconLg } from "../../../styles/spacing";
import Dialog from "../../../components/Dialog";
import { Input, Select, FormField, SecondaryButton, SuccessButton } from "../../../components/forms";
import { h2, alertDanger, caption } from "../../../styles";
import { selectionButtonClass } from "../../../styles/buttonStyles";
import type { MetaFields, ValidationError, ProtocolType, SerialEncoding } from "../types";

export type NewCatalogDialogProps = {
  open: boolean;

  metaFields: MetaFields;
  setMetaFields: (next: MetaFields) => void;

  // CAN config - stored in [meta.can]
  canDefaultEndianness: "little" | "big";
  setCanDefaultEndianness: (endianness: "little" | "big") => void;
  canDefaultInterval: number | undefined;
  setCanDefaultInterval: (interval: number | undefined) => void;

  // Modbus config - stored in [meta.modbus]
  modbusDeviceAddress: number;
  setModbusDeviceAddress: (addr: number) => void;
  modbusRegisterBase: 0 | 1;
  setModbusRegisterBase: (base: 0 | 1) => void;

  // Serial encoding - stored in [meta.serial]
  serialEncoding: SerialEncoding;
  setSerialEncoding: (encoding: SerialEncoding) => void;

  validationErrors: ValidationError[];

  onCancel: () => void;
  onCreate: (selectedProtocol: ProtocolType) => void;
};

export default function NewCatalogDialog({
  open,
  metaFields,
  setMetaFields,
  canDefaultEndianness,
  setCanDefaultEndianness,
  canDefaultInterval,
  setCanDefaultInterval,
  modbusDeviceAddress,
  setModbusDeviceAddress,
  modbusRegisterBase,
  setModbusRegisterBase,
  serialEncoding,
  setSerialEncoding,
  validationErrors,
  onCancel,
  onCreate,
}: NewCatalogDialogProps) {
  const { t } = useTranslation("catalog");

  // Protocol configuration for buttons
  const protocols: Array<{
    type: ProtocolType;
    label: string;
    icon: React.ComponentType<{ className?: string }>;
    namePlaceholder: string;
  }> = [
    { type: "can", label: t("newCatalog.protocolCan"), icon: Network, namePlaceholder: t("newCatalog.namePlaceholderCan") },
    { type: "modbus", label: t("newCatalog.protocolModbus"), icon: Server, namePlaceholder: t("newCatalog.namePlaceholderModbus") },
    { type: "serial", label: t("newCatalog.protocolSerial"), icon: Cable, namePlaceholder: t("newCatalog.namePlaceholderSerial") },
  ];

  // Local state for selected protocol (determines which config section to show)
  const [selectedProtocol, setSelectedProtocol] = useState<ProtocolType>("can");

  // Reset to CAN when dialog opens
  useEffect(() => {
    if (open) {
      setSelectedProtocol("can");
    }
  }, [open]);

  const versionInvalid = !metaFields.version || metaFields.version < 1;
  const nameInvalid = !metaFields.name;

  const metaError = validationErrors.find((e) => e.field === "meta");

  const currentProtocolConfig = protocols.find((p) => p.type === selectedProtocol);

  return (
    <Dialog isOpen={open} maxWidth="max-w-2xl">
      <div className="p-6 max-h-[90vh] overflow-y-auto">
        <h2 className={`${h2} mb-6`}>{t("newCatalog.title")}</h2>

        {metaError && (
          <div className={`${alertDanger} mb-4`}>
            {metaError.message}
          </div>
        )}

        <div className="space-y-4">
          {/* Protocol Selector Buttons */}
          <FormField label={t("newCatalog.protocolType")} variant="default">
            <div className="grid grid-cols-3 gap-3">
              {protocols.map(({ type, label, icon: Icon }) => {
                const isSelected = selectedProtocol === type;
                return (
                  <button
                    key={type}
                    type="button"
                    onClick={() => setSelectedProtocol(type)}
                    className={selectionButtonClass(isSelected)}
                  >
                    <Icon
                      className={`${iconLg} ${
                        isSelected ? "text-[color:var(--accent-primary)]" : "text-[color:var(--text-muted)]"
                      }`}
                    />
                    <span
                      className={`font-medium ${
                        isSelected ? "text-[color:var(--accent-primary)]" : "text-[color:var(--text-secondary)]"
                      }`}
                    >
                      {label}
                    </span>
                  </button>
                );
              })}
            </div>
          </FormField>

          {/* Name */}
          <FormField label={t("newCatalog.name")} required variant="default">
            <Input
              variant="default"
              value={metaFields.name}
              onChange={(e) => setMetaFields({ ...metaFields, name: e.target.value })}
              placeholder={currentProtocolConfig?.namePlaceholder ?? t("newCatalog.namePlaceholderDefault")}
            />
          </FormField>

          {/* Version */}
          <FormField label={t("newCatalog.version")} required variant="default">
            <Input
              variant="default"
              type="number"
              min={1}
              value={metaFields.version || ""}
              onChange={(e) => {
                const val = e.target.value;
                setMetaFields({ ...metaFields, version: val === "" ? 0 : parseInt(val) });
              }}
              className={versionInvalid ? "border-[color:var(--status-danger-border)] bg-[var(--status-danger-bg)]" : ""}
            />
          </FormField>

          {/* CAN-specific fields */}
          {selectedProtocol === "can" && (
            <>
              {/* Default Byte Order */}
              <FormField label={t("newCatalog.defaultByteOrder")} required variant="default">
                <Select
                  variant="default"
                  value={canDefaultEndianness}
                  onChange={(e) => setCanDefaultEndianness(e.target.value as "little" | "big")}
                >
                  <option value="little">{t("newCatalog.endianLE")}</option>
                  <option value="big">{t("newCatalog.endianBE")}</option>
                </Select>
              </FormField>

              {/* Default Interval */}
              <FormField label={t("newCatalog.defaultIntervalOptional")} variant="default">
                <Input
                  variant="default"
                  type="number"
                  min={0}
                  value={canDefaultInterval !== undefined ? canDefaultInterval : ""}
                  onChange={(e) => setCanDefaultInterval(e.target.value ? parseInt(e.target.value) : undefined)}
                  placeholder={t("newCatalog.intervalPlaceholder")}
                />
              </FormField>
            </>
          )}

          {/* Modbus-specific fields */}
          {selectedProtocol === "modbus" && (
            <>
              {/* Device Address */}
              <FormField label={t("newCatalog.deviceAddress")} required variant="default">
                <Input
                  variant="default"
                  type="number"
                  min={1}
                  max={247}
                  value={modbusDeviceAddress}
                  onChange={(e) => setModbusDeviceAddress(parseInt(e.target.value) || 1)}
                  placeholder={t("newCatalog.deviceAddressPlaceholder")}
                />
                <p className={`mt-1 ${caption}`}>
                  {t("newCatalog.deviceAddressHint")}
                </p>
              </FormField>

              {/* Register Base */}
              <FormField label={t("newCatalog.registerAddressing")} required variant="default">
                <Select
                  variant="default"
                  value={modbusRegisterBase}
                  onChange={(e) => setModbusRegisterBase(parseInt(e.target.value) as 0 | 1)}
                >
                  <option value={1}>{t("newCatalog.registerBase1")}</option>
                  <option value={0}>{t("newCatalog.registerBase0")}</option>
                </Select>
              </FormField>
            </>
          )}

          {/* Serial-specific fields */}
          {selectedProtocol === "serial" && (
            <FormField label={t("newCatalog.encoding")} required variant="default">
              <Select
                variant="default"
                value={serialEncoding}
                onChange={(e) => setSerialEncoding(e.target.value as SerialEncoding)}
              >
                <option value="slip">{t("newCatalog.encodingSlip")}</option>
                <option value="cobs">{t("newCatalog.encodingCobs")}</option>
                <option value="raw">{t("newCatalog.encodingRaw")}</option>
                <option value="length_prefixed">{t("newCatalog.encodingLengthPrefixed")}</option>
              </Select>
              <p className={`mt-1 ${caption}`}>
                {t("newCatalog.encodingHint")}
              </p>
            </FormField>
          )}
        </div>

        <div className="flex justify-end gap-3 mt-6">
          <SecondaryButton onClick={onCancel}>{t("newCatalog.cancel")}</SecondaryButton>
          <SuccessButton onClick={() => onCreate(selectedProtocol)} disabled={nameInvalid || versionInvalid}>
            {t("newCatalog.createButton")}
          </SuccessButton>
        </div>
      </div>
    </Dialog>
  );
}
