// ui/src/apps/catalog/views/MetaView.tsx

import { useTranslation } from "react-i18next";
import { FileText, Pencil, Network, Cable, Check } from "lucide-react";
import { iconMd, iconXs, iconLg, flexRowGap2 } from "../../../styles/spacing";
import { labelSmallMuted, monoBody, bgSurface, captionMuted, sectionHeaderText } from "../../../styles";
import type { Catalog } from "../../../types/catalogModel";
import { hasFrames } from "../model";
import { IconButton } from "../../../components/Button";
import { Card } from "../../../components/Card";
export type MetaViewProps = {
  catalog: Catalog | null;
  onEditMeta: () => void;
};

export default function MetaView({ catalog, onEditMeta }: MetaViewProps) {
  const { t } = useTranslation("catalog");
  if (!catalog) return null;
  const { meta, can: canConfig, serial: serialConfig, modbus: modbusConfig, effectiveDefaults } = catalog;
  return (
    <div className="space-y-6">
      {/* Header with actions */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-info rounded-lg">
            <FileText className={`${iconLg} text-info`} />
          </div>
          <div>
            <div className="text-lg font-bold text-primary">
              {t("metaView.title")}
            </div>
            <p className="text-sm text-muted">
              {t("metaView.subtitle")}
            </p>
          </div>
        </div>
        <IconButton
          onClick={onEditMeta}
          title={t("metaView.editTooltip")}
        >
          <Pencil className={`${iconMd} text-secondary`} />
        </IconButton>
      </div>

      {/* Property cards */}
      <div className="grid grid-cols-2 gap-4">
        <div className={`p-4 ${bgSurface} rounded-lg`}>
          <div className={labelSmallMuted}>
            {t("metaView.name")} <span className="text-danger">{t("metaView.required")}</span>
          </div>
          <div className={monoBody}>
            {meta.name || <span className="text-danger">{t("metaView.notSet")}</span>}
          </div>
        </div>

        <div className={`p-4 ${bgSurface} rounded-lg`}>
          <div className={labelSmallMuted}>
            {t("metaView.version")} <span className="text-danger">{t("metaView.required")}</span>
          </div>
          <div className={monoBody}>
            {meta.version}
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
          icon={<Network className={`${iconMd} text-success`} />}
          iconBg="bg-success"
          name={t("metaView.canName")}
          isConfigured={!!canConfig}
          hasFrames={hasFrames(catalog, "can")}
        >
          {canConfig && (
            <div className="text-xs text-muted">
              <span>{t("metaView.byteOrder", { order: effectiveDefaults.canByteOrder })}</span>
              {canConfig.defaultInterval !== undefined && (
                <span> • {t("metaView.intervalMs", { ms: canConfig.defaultInterval })}</span>
              )}
              {canConfig.frameIdMask !== undefined && (
                <span> • {t("metaView.maskHex", { hex: canConfig.frameIdMask.toString(16).toUpperCase() })}</span>
              )}
              {canConfig.fields && Object.keys(canConfig.fields).length > 0 && (
                <span> • {t("metaView.headerFields", { count: Object.keys(canConfig.fields).length })}</span>
              )}
            </div>
          )}
        </ProtocolConfigCard>

        {/* Serial Config */}
        <ProtocolConfigCard
          icon={<Cable className={`${iconMd} text-info`} />}
          iconBg="bg-info"
          name={t("metaView.serialName")}
          isConfigured={!!serialConfig}
          hasFrames={hasFrames(catalog, "serial")}
        >
          {serialConfig && (
            <div className="text-xs text-muted">
              <span>{t("metaView.encoding", { encoding: serialConfig.encoding?.toUpperCase() })}</span>
              <span> • {effectiveDefaults.serialByteOrder === 'big' ? t("metaView.endianBE") : t("metaView.endianLE")}</span>
              {serialConfig.headerLength !== undefined && (
                <span> • {t("metaView.headerLength", { length: serialConfig.headerLength })}</span>
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
          icon={<Network className={`${iconMd} text-warning`} />}
          iconBg="bg-warning"
          name={t("metaView.modbusName")}
          isConfigured={!!modbusConfig}
          hasFrames={hasFrames(catalog, "modbus")}
        >
          {modbusConfig && (
            <div className="text-xs text-muted">
              {modbusConfig.deviceAddress !== undefined && (
                <span>{t("metaView.address", { addr: modbusConfig.deviceAddress })} • </span>
              )}
              <span>{t("metaView.registerBase", { base: effectiveDefaults.modbusRegisterBase })}</span>
              {modbusConfig.defaultInterval !== undefined && (
                <span> • {t("metaView.intervalMs", { ms: modbusConfig.defaultInterval })}</span>
              )}
              <span> • {t("metaView.byteShort", { order: effectiveDefaults.modbusByteOrder === "big" ? t("metaView.endianBE") : t("metaView.endianLE") })}</span>
              <span> • {t("metaView.wordShort", { order: effectiveDefaults.modbusWordOrder === "big" ? t("metaView.endianBE") : t("metaView.endianLE") })}</span>
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
    <Card className="flex items-start gap-3">
      <div className={`p-1.5 ${iconBg} rounded`}>
        {icon}
      </div>
      <div className="flex-1 min-w-0">
        <div className={flexRowGap2}>
          <span className="font-medium text-sm text-primary">{name}</span>
          {isConfigured && (
            <span className="flex items-center gap-1 text-xs text-success">
              <Check className={iconXs} />
              {t("metaView.configured")}
            </span>
          )}
          {showWarning && (
            <span className="text-xs text-warning">
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
    </Card>
  );
}
