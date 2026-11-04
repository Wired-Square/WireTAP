// ui/src/apps/catalog/dialogs/config-sections/ModbusConfigSection.tsx
// Modbus protocol configuration section for unified config dialog

import { useTranslation } from "react-i18next";
import { Network } from "lucide-react";
import { iconMd } from "../../../../styles/spacing";
import { caption, textMedium } from "../../../../styles/typography";
import { Select, Input } from "../../../../components/forms";
import { Card } from "../../../../components/Card";
import { protocolLabel } from "../../../../utils/profileTraits";
import { ConfigSectionHeader } from "./ConfigSectionHeader";
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
  const { t } = useTranslation("catalog");
  const showWarning = hasFrames && !isConfigured;

  return (
    <Card padding="none" className="overflow-hidden">
      <ConfigSectionHeader
        label={protocolLabel("modbus")}
        icon={<Network className={iconMd} />}
        tone="warning"
        isConfigured={isConfigured}
        showWarning={showWarning}
        isExpanded={isExpanded}
        onToggleExpanded={onToggleExpanded}
        onAdd={onAdd}
        onRemove={onRemove}
      />

      {isExpanded && isConfigured && (
        <div className="p-4 space-y-4 border-t border-default">
          <div>
            <label className={`block ${textMedium} mb-2`}>
              {t("modbusConfig.registerBase")} <span className="text-danger">*</span>
            </label>
            <Select
              value={registerBase}
              onChange={(e) => setRegisterBase(parseInt(e.target.value) as 0 | 1)}
              size="lg"
            >
              <option value={0}>{t("configSections.modbus.base0")}</option>
              <option value={1}>{t("configSections.modbus.base1")}</option>
            </Select>
            <p className={`mt-1 ${caption}`}>
              {t("configSections.modbus.registerBaseHint")}
            </p>
          </div>

          <div>
            <label className={`block ${textMedium} mb-2`}>
              {t("configSections.modbus.pollInterval")}
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
              <span className="text-sm text-muted whitespace-nowrap">ms</span>
            </div>
            <p className={`mt-1 ${caption}`}>
              {t("configSections.modbus.pollIntervalHint")}
            </p>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className={`block ${textMedium} mb-2`}>
                {t("canConfig.defaultByteOrder")}
              </label>
              <Select
                value={defaultByteOrder}
                onChange={(e) => setDefaultByteOrder(e.target.value as "big" | "little")}
                size="lg"
              >
                <option value="big">{t("modbusConfig.endianBE")}</option>
                <option value="little">{t("modbusConfig.endianLE")}</option>
              </Select>
              <p className={`mt-1 ${caption}`}>
                {t("configSections.modbus.byteOrderHint")}
              </p>
            </div>

            <div>
              <label className={`block ${textMedium} mb-2`}>
                {t("configSections.modbus.wordOrder")}
              </label>
              <Select
                value={defaultWordOrder}
                onChange={(e) => setDefaultWordOrder(e.target.value as "big" | "little")}
                size="lg"
              >
                <option value="big">{t("configSections.modbus.wordBig")}</option>
                <option value="little">{t("configSections.modbus.wordLittle")}</option>
              </Select>
              <p className={`mt-1 ${caption}`}>
                {t("configSections.modbus.wordOrderHint")}
              </p>
            </div>
          </div>
        </div>
      )}

      {!isExpanded && isConfigured && (
        <div className={`px-4 py-2 ${caption} border-t border-default`}>
          {[
            t("configSections.modbus.summaryBase", { base: registerBase }),
            defaultInterval !== undefined && t("configSections.summaryInterval", { ms: defaultInterval }),
            t("configSections.modbus.summaryByte", { order: defaultByteOrder === "big" ? "BE" : "LE" }),
            t("configSections.modbus.summaryWord", { order: defaultWordOrder === "big" ? "BE" : "LE" }),
          ].filter(Boolean).join(" • ")}
        </div>
      )}
    </Card>
  );
}
