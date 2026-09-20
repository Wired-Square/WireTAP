// ui/src/apps/catalog/views/ModbusConfigView.tsx

import { useTranslation } from "react-i18next";
import { Network, Pencil } from "lucide-react";
import { iconMd, iconLg } from "../../../styles/spacing";
import { labelSmallMuted, monoBody, bgSurface } from "../../../styles";
import type { TomlNode, ModbusProtocolConfig } from "../types";
import { IconButton } from "../../../components/Button";

export type ModbusConfigViewProps = {
  selectedNode: TomlNode;
  modbusConfig?: ModbusProtocolConfig;
  onEditConfig?: () => void;
};

export default function ModbusConfigView({
  selectedNode,
  modbusConfig,
  onEditConfig,
}: ModbusConfigViewProps) {
  const { t } = useTranslation("catalog");
  const registerBase = modbusConfig?.register_base ?? selectedNode.metadata?.registerBase;
  const defaultInterval = modbusConfig?.default_interval;
  const defaultByteOrder = modbusConfig?.default_byte_order;
  const defaultWordOrder = modbusConfig?.default_word_order;

  return (
    <div className="space-y-6">
      {/* Header with actions */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-warning rounded-lg">
            <Network className={`${iconLg} text-amber`} />
          </div>
          <div>
            <div className="text-lg font-bold text-primary">
              {t("modbusConfig.title")}
            </div>
            <p className="text-sm text-muted">
              {t("modbusConfig.subtitle")}
            </p>
          </div>
        </div>
        {onEditConfig && (
          <IconButton
            onClick={onEditConfig}
            title={t("modbusConfig.editTooltip")}
          >
            <Pencil className={`${iconMd} text-secondary`} />
          </IconButton>
        )}
      </div>

      {/* Property cards. The device (slave) address now lives on each slave
          node, not on [meta.modbus]. */}
      <div className="grid grid-cols-2 gap-4">
        <div className={`p-4 ${bgSurface} rounded-lg`}>
          <div className={labelSmallMuted}>
            {t("modbusConfig.registerBase")}
          </div>
          <div className={monoBody}>
            {registerBase !== undefined ? (
              registerBase === 0 ? t("modbusConfig.registerBase0") : t("modbusConfig.registerBase1")
            ) : (
              <span className="text-orange-500">{t("modbusConfig.notSet")}</span>
            )}
          </div>
        </div>

        <div className={`p-4 ${bgSurface} rounded-lg`}>
          <div className={labelSmallMuted}>
            {t("modbusConfig.defaultInterval")}
          </div>
          <div className={monoBody}>
            {defaultInterval !== undefined ? (
              t("modbusConfig.intervalMs", { ms: defaultInterval })
            ) : (
              <span className="text-muted">{t("modbusConfig.notSet")}</span>
            )}
          </div>
        </div>

        <div className={`p-4 ${bgSurface} rounded-lg`}>
          <div className={labelSmallMuted}>
            {t("modbusConfig.byteOrder")}
          </div>
          <div className={monoBody}>
            {defaultByteOrder !== undefined ? (
              defaultByteOrder === "big" ? t("modbusConfig.endianBE") : t("modbusConfig.endianLE")
            ) : (
              <span className="text-muted">{t("modbusConfig.notSet")}</span>
            )}
          </div>
        </div>

        <div className={`p-4 ${bgSurface} rounded-lg`}>
          <div className={labelSmallMuted}>
            {t("modbusConfig.wordOrder")}
          </div>
          <div className={monoBody}>
            {defaultWordOrder !== undefined ? (
              defaultWordOrder === "big" ? t("modbusConfig.endianBE") : t("modbusConfig.endianLE")
            ) : (
              <span className="text-muted">{t("modbusConfig.notSet")}</span>
            )}
          </div>
        </div>
      </div>

      {/* Info box */}
      <div className="p-4 bg-info rounded-lg border border-info">
        <p className="text-sm text-info">
          <strong>{t("modbusConfig.noteTitle")}</strong> {t("modbusConfig.noteText")}
        </p>
      </div>
    </div>
  );
}
