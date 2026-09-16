// ui/src/apps/catalog/views/CanConfigView.tsx

import { useTranslation } from "react-i18next";
import { Network, Pencil } from "lucide-react";
import { iconMd, iconLg } from "../../../styles/spacing";
import { labelSmallMuted, monoBody, iconButtonHover, bgSecondary } from "../../../styles";
import type { TomlNode, CanProtocolConfig } from "../types";

export type CanConfigViewProps = {
  selectedNode: TomlNode;
  canConfig?: CanProtocolConfig;
  onEditConfig?: () => void;
};

export default function CanConfigView({
  selectedNode,
  canConfig,
  onEditConfig,
}: CanConfigViewProps) {
  const { t } = useTranslation("catalog");
  // Get values from canConfig (parsed from TOML) or fallback to node metadata
  const defaultEndianness = canConfig?.default_endianness ?? selectedNode.metadata?.properties?.default_endianness;
  const defaultInterval = canConfig?.default_interval ?? selectedNode.metadata?.properties?.default_interval;
  const defaultExtended = canConfig?.default_extended ?? selectedNode.metadata?.properties?.default_extended;
  const defaultFd = canConfig?.default_fd ?? selectedNode.metadata?.properties?.default_fd;

  return (
    <div className="space-y-6">
      {/* Header with actions */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-[var(--status-success-bg)] rounded-lg">
            <Network className={`${iconLg} text-[color:var(--status-success)]`} />
          </div>
          <div>
            <div className="text-lg font-bold text-[color:var(--text-primary)]">
              {t("canConfig.title")}
            </div>
            <p className="text-sm text-[color:var(--text-muted)]">
              {t("canConfig.subtitle")}
            </p>
          </div>
        </div>
        {onEditConfig && (
          <button
            onClick={onEditConfig}
            className={iconButtonHover}
            title={t("canConfig.editTooltip")}
          >
            <Pencil className={`${iconMd} text-[color:var(--text-secondary)]`} />
          </button>
        )}
      </div>

      {/* Property cards */}
      <div className="grid grid-cols-2 gap-4">
        <div className={`p-4 ${bgSecondary} rounded-lg`}>
          <div className={labelSmallMuted}>
            {t("canConfig.defaultByteOrder")}
          </div>
          <div className={monoBody}>
            {defaultEndianness ? (
              defaultEndianness === "little" ? t("canConfig.endianLE") : t("canConfig.endianBE")
            ) : (
              <span className="text-orange-500">{t("canConfig.notSet")}</span>
            )}
          </div>
        </div>

        <div className={`p-4 ${bgSecondary} rounded-lg`}>
          <div className={labelSmallMuted}>
            {t("canConfig.defaultInterval")}
          </div>
          <div className={monoBody}>
            {defaultInterval !== undefined ? (
              t("canConfig.intervalMs", { ms: defaultInterval })
            ) : (
              <span className="text-slate-400">{t("canConfig.notSpecified")}</span>
            )}
          </div>
        </div>

        <div className={`p-4 ${bgSecondary} rounded-lg`}>
          <div className={labelSmallMuted}>
            {t("canConfig.defaultExtendedId")}
          </div>
          <div className={monoBody}>
            {defaultExtended === true ? (
              t("canConfig.yes29bit")
            ) : defaultExtended === false ? (
              t("canConfig.no11bit")
            ) : (
              <span className="text-slate-400">{t("canConfig.autoDetect")}</span>
            )}
          </div>
        </div>

        <div className={`p-4 ${bgSecondary} rounded-lg`}>
          <div className={labelSmallMuted}>
            {t("canConfig.defaultCanFd")}
          </div>
          <div className={monoBody}>
            {defaultFd === true ? (
              t("canConfig.yes")
            ) : defaultFd === false ? (
              t("canConfig.noClassic")
            ) : (
              <span className="text-slate-400">{t("canConfig.classicCan")}</span>
            )}
          </div>
        </div>
      </div>

      {/* Info box */}
      <div className="p-4 bg-[var(--status-info-bg)] rounded-lg border border-[color:var(--status-info-border)]">
        <p className="text-sm text-[color:var(--status-info)]">
          <strong>{t("canConfig.noteTitle")}</strong> {t("canConfig.noteText")}
        </p>
      </div>
    </div>
  );
}
