// ui/src/apps/catalog/views/MetaView.tsx

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
              Catalog Metadata
            </div>
            <p className="text-sm text-[color:var(--text-muted)]">
              Name, version, and protocol settings
            </p>
          </div>
        </div>
        <button
          onClick={onEditMeta}
          className={iconButtonHover}
          title="Edit metadata and config"
        >
          <Pencil className={`${iconMd} text-[color:var(--text-secondary)]`} />
        </button>
      </div>

      {/* Property cards */}
      <div className="grid grid-cols-2 gap-4">
        <div className={`p-4 ${bgSecondary} rounded-lg`}>
          <div className={labelSmallMuted}>
            Name <span className="text-red-500">*</span>
          </div>
          <div className={monoBody}>
            {metaFields.name || <span className="text-red-500">Not set</span>}
          </div>
        </div>

        <div className={`p-4 ${bgSecondary} rounded-lg`}>
          <div className={labelSmallMuted}>
            Version <span className="text-red-500">*</span>
          </div>
          <div className={monoBody}>
            {metaFields.version}
          </div>
        </div>
      </div>

      {/* Protocol Configurations */}
      <div className="space-y-3">
        <h3 className={sectionHeaderText}>
          Protocol Configurations
        </h3>

        {/* CAN Config */}
        <ProtocolConfigCard
          icon={<Network className={`${iconMd} text-[color:var(--status-success)]`} />}
          iconBg="bg-[var(--status-success-bg)]"
          name="CAN"
          isConfigured={!!canConfig}
          hasFrames={hasCanFrames}
        >
          {canConfig && (
            <div className="text-xs text-[color:var(--text-muted)]">
              <span>Endianness: {canConfig.default_endianness}</span>
              {canConfig.default_interval !== undefined && (
                <span> • Interval: {canConfig.default_interval}ms</span>
              )}
              {canConfig.frame_id_mask !== undefined && (
                <span> • Mask: 0x{canConfig.frame_id_mask.toString(16).toUpperCase()}</span>
              )}
              {canConfig.fields && Object.keys(canConfig.fields).length > 0 && (
                <span> • {Object.keys(canConfig.fields).length} header field(s)</span>
              )}
            </div>
          )}
        </ProtocolConfigCard>

        {/* Serial Config */}
        <ProtocolConfigCard
          icon={<Cable className={`${iconMd} text-[color:var(--status-info)]`} />}
          iconBg="bg-[var(--status-info-bg)]"
          name="Serial"
          isConfigured={!!serialConfig}
          hasFrames={hasSerialFrames}
        >
          {serialConfig && (
            <div className="text-xs text-[color:var(--text-muted)]">
              <span>Encoding: {serialConfig.encoding?.toUpperCase()}</span>
              {serialConfig.byte_order && (
                <span> • {serialConfig.byte_order === 'big' ? 'BE' : 'LE'}</span>
              )}
              {serialConfig.header_length !== undefined && (
                <span> • Header: {serialConfig.header_length}B</span>
              )}
              {serialConfig.fields && Object.keys(serialConfig.fields).length > 0 && (
                <span> • {Object.keys(serialConfig.fields).length} field(s)</span>
              )}
              {serialConfig.checksum && (
                <span> • Checksum: {serialConfig.checksum.algorithm.toUpperCase()}</span>
              )}
            </div>
          )}
        </ProtocolConfigCard>

        {/* Modbus Config */}
        <ProtocolConfigCard
          icon={<Network className={`${iconMd} text-[color:var(--status-warning)]`} />}
          iconBg="bg-[var(--status-warning-bg)]"
          name="Modbus"
          isConfigured={!!modbusConfig}
          hasFrames={hasModbusFrames}
        >
          {modbusConfig && (
            <div className="text-xs text-[color:var(--text-muted)]">
              <span>Address: {modbusConfig.device_address}</span>
              <span> • Base: {modbusConfig.register_base}-based</span>
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
              configured
            </span>
          )}
          {showWarning && (
            <span className="text-xs text-[color:var(--status-warning)]">
              frames exist, no config
            </span>
          )}
          {!isConfigured && !hasFrames && (
            <span className={captionMuted}>
              not configured
            </span>
          )}
        </div>
        {children}
      </div>
    </div>
  );
}
