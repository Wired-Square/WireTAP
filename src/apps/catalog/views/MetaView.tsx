// ui/src/apps/catalog/views/MetaView.tsx

import { useTranslation } from "react-i18next";
import { FileText, Pencil, Network, Cable, Check } from "lucide-react";
import { iconMd, iconXs, iconLg, flexRowGap2 } from "../../../styles/spacing";
import { labelSmallMuted, monoBody, iconButtonHover, bgSecondary, captionMuted, sectionHeaderText } from "../../../styles";
import type { MetaFields, CanProtocolConfig, SerialProtocolConfig, ModbusProtocolConfig } from "../types";

export type MetaViewProps = {
  metaFields: MetaFields;
  canConfig?: CanProtocolConfig;
  serialConfig?: SerialProtocolConfig;
  modbusConfig?: ModbusProtocolConfig;
  hasCanFrames?: boolean;
  hasSerialFrames?: boolean;
  hasModbusFrames?: boolean;
  onEditMeta: () => void;
};

export default function MetaView({
  metaFields,
  canConfig,
  serialConfig,
  modbusConfig,
  hasCanFrames,
  hasSerialFrames,
  hasModbusFrames,
  onEditMeta,
}: MetaViewProps) {
  const { t } = useTranslation("catalog");
  return (
    <div className="space-y-6">
      {/* Header with actions */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-[var(--accent-bg)] rounded-lg">
            <FileText className={`${iconLg} text-[color:var(--accent-text)]`} />
          </div>
          <div>
            <div className="text-lg font-bold text-[color:var(--text-primary)]">
              {t("metaView.title")}
            </div>
            <p className="text-sm text-[color:var(--text-muted)]">
              {t("metaView.subtitle")}
            </p>
          </div>
        </div>
        <button
          onClick={onEditMeta}
          className={iconButtonHover}
          title={t("metaView.editTooltip")}
        >
          <Pencil className={`${iconMd} text-[color:var(--text-secondary)]`} />
        </button>
      </div>

      {/* Property cards */}
      <div className="grid grid-cols-2 gap-4">
        <div className={`p-4 ${bgSecondary} rounded-lg`}>
          <div className={labelSmallMuted}>
            {t("metaView.name")} <span className="text-red-500">{t("metaView.required")}</span>
          </div>
          <div className={monoBody}>
            {metaFields.name || <span className="text-red-500">{t("metaView.notSet")}</span>}
          </div>
        </div>

        <div className={`p-4 ${bgSecondary} rounded-lg`}>
          <div className={labelSmallMuted}>
            {t("metaView.version")} <span className="text-red-500">{t("metaView.required")}</span>
          </div>
          <div className={monoBody}>
            {metaFields.version}
          </div>
        </div>
      </div>

      {/* Protocol Configurations */}
      <div className="space-y-3">
        <h3 className={sectionHeaderText}>
          {t("metaView.protocolConfigurations")}
        </h3>

        {/* CAN Config */}
        <ProtocolConfigCard
          icon={<Network className={`${iconMd} text-[color:var(--status-success)]`} />}
          iconBg="bg-[var(--status-success-bg)]"
          name={t("metaView.canName")}
          isConfigured={!!canConfig}
          hasFrames={hasCanFrames}
        >
          {canConfig && (
            <div className="text-xs text-[color:var(--text-muted)]">
              <span>{t("metaView.byteOrder", { order: canConfig.default_endianness })}</span>
              {canConfig.default_interval !== undefined && (
                <span> • {t("metaView.intervalMs", { ms: canConfig.default_interval })}</span>
              )}
              {canConfig.frame_id_mask !== undefined && (
                <span> • {t("metaView.maskHex", { hex: canConfig.frame_id_mask.toString(16).toUpperCase() })}</span>
              )}
              {canConfig.fields && Object.keys(canConfig.fields).length > 0 && (
                <span> • {t("metaView.headerFields", { count: Object.keys(canConfig.fields).length })}</span>
              )}
            </div>
          )}
        </ProtocolConfigCard>

        {/* Serial Config */}
        <ProtocolConfigCard
          icon={<Cable className={`${iconMd} text-[color:var(--status-info)]`} />}
          iconBg="bg-[var(--status-info-bg)]"
          name={t("metaView.serialName")}
          isConfigured={!!serialConfig}
          hasFrames={hasSerialFrames}
        >
          {serialConfig && (
            <div className="text-xs text-[color:var(--text-muted)]">
              <span>{t("metaView.encoding", { encoding: serialConfig.encoding?.toUpperCase() })}</span>
              {serialConfig.byte_order && (
                <span> • {serialConfig.byte_order === 'big' ? t("metaView.endianBE") : t("metaView.endianLE")}</span>
              )}
              {serialConfig.header_length !== undefined && (
                <span> • {t("metaView.headerLength", { length: serialConfig.header_length })}</span>
              )}
              {serialConfig.fields && Object.keys(serialConfig.fields).length > 0 && (
                <span> • {t("metaView.fields", { count: Object.keys(serialConfig.fields).length })}</span>
              )}
              {serialConfig.checksum && (
                <span> • {t("metaView.checksumLabel", { algo: serialConfig.checksum.algorithm.toUpperCase() })}</span>
              )}
            </div>
          )}
        </ProtocolConfigCard>

        {/* Modbus Config */}
        <ProtocolConfigCard
          icon={<Network className={`${iconMd} text-[color:var(--status-warning)]`} />}
          iconBg="bg-[var(--status-warning-bg)]"
          name={t("metaView.modbusName")}
          isConfigured={!!modbusConfig}
          hasFrames={hasModbusFrames}
        >
          {modbusConfig && (
            <div className="text-xs text-[color:var(--text-muted)]">
              <span>{t("metaView.address", { addr: modbusConfig.device_address })}</span>
              <span> • {t("metaView.registerBase", { base: modbusConfig.register_base })}</span>
              {modbusConfig.default_interval !== undefined && (
                <span> • {t("metaView.intervalMs", { ms: modbusConfig.default_interval })}</span>
              )}
              {modbusConfig.default_byte_order && (
                <span> • {t("metaView.byteShort", { order: modbusConfig.default_byte_order === "big" ? t("metaView.endianBE") : t("metaView.endianLE") })}</span>
              )}
              {modbusConfig.default_word_order && (
                <span> • {t("metaView.wordShort", { order: modbusConfig.default_word_order === "big" ? t("metaView.endianBE") : t("metaView.endianLE") })}</span>
              )}
            </div>
          )}
        </ProtocolConfigCard>
      </div>
    </div>
  );
}

// Helper component for protocol config cards
function ProtocolConfigCard({
  icon,
  iconBg,
  name,
  isConfigured,
  hasFrames,
  children,
}: {
  icon: React.ReactNode;
  iconBg: string;
  name: string;
  isConfigured: boolean;
  hasFrames?: boolean;
  children?: React.ReactNode;
}) {
  const { t } = useTranslation("catalog");
  const showWarning = hasFrames && !isConfigured;

  return (
    <div className={`flex items-start gap-3 p-3 ${bgSecondary} rounded-lg border border-[color:var(--border-default)]`}>
      <div className={`p-1.5 ${iconBg} rounded`}>
        {icon}
      </div>
      <div className="flex-1 min-w-0">
        <div className={flexRowGap2}>
          <span className="font-medium text-sm text-[color:var(--text-primary)]">{name}</span>
          {isConfigured && (
            <span className="flex items-center gap-1 text-xs text-[color:var(--status-success)]">
              <Check className={iconXs} />
              {t("metaView.configured")}
            </span>
          )}
          {showWarning && (
            <span className="text-xs text-[color:var(--status-warning)]">
              {t("metaView.framesNoConfig")}
            </span>
          )}
          {!isConfigured && !hasFrames && (
            <span className={captionMuted}>
              {t("metaView.notConfigured")}
            </span>
          )}
        </div>
        {children}
      </div>
    </div>
  );
}
