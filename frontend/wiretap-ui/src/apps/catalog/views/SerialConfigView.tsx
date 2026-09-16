// ui/src/apps/catalog/views/SerialConfigView.tsx

import { useTranslation } from "react-i18next";
import { Cable, Pencil } from "lucide-react";
import { iconMd, iconLg } from "../../../styles/spacing";
import { caption, labelSmallMuted, monoBody, iconButtonHover, bgSecondary } from "../../../styles";
import type { TomlNode } from "../types";

export type SerialConfigViewProps = {
  selectedNode: TomlNode;
  onEditConfig?: () => void;
};

export default function SerialConfigView({
  selectedNode,
  onEditConfig,
}: SerialConfigViewProps) {
  const { t } = useTranslation("catalog");
  const encoding = selectedNode.metadata?.encoding;

  const encodingLabels: Record<string, string> = {
    slip: t("serialConfig.encodingSlip"),
    cobs: t("serialConfig.encodingCobs"),
    raw: t("serialConfig.encodingRaw"),
    length_prefixed: t("serialConfig.encodingLengthPrefixed"),
  };

  return (
    <div className="space-y-6">
      {/* Header with actions */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-[var(--purple-bg)] rounded-lg">
            <Cable className={`${iconLg} text-[color:var(--purple-text)]`} />
          </div>
          <div>
            <div className="text-lg font-bold text-[color:var(--text-primary)]">
              {t("serialConfig.title")}
            </div>
            <p className="text-sm text-[color:var(--text-muted)]">
              {t("serialConfig.subtitle")}
            </p>
          </div>
        </div>
        {onEditConfig && (
          <button
            onClick={onEditConfig}
            className={iconButtonHover}
            title={t("serialConfig.editTooltip")}
          >
            <Pencil className={`${iconMd} text-[color:var(--text-secondary)]`} />
          </button>
        )}
      </div>

      {/* Property cards */}
      <div className="grid grid-cols-2 gap-4">
        <div className={`p-4 ${bgSecondary} rounded-lg col-span-2`}>
          <div className={labelSmallMuted}>
            {t("serialConfig.encoding")}
          </div>
          <div className={monoBody}>
            {encoding ? (
              <span className="uppercase">{encodingLabels[encoding] || encoding}</span>
            ) : (
              <span className="text-orange-500">{t("serialConfig.encodingNotSet")}</span>
            )}
          </div>
          <p className={`${caption} mt-2`}>
            {t("serialConfig.encodingApplies")}
          </p>
        </div>
      </div>

      {/* Info box */}
      <div className="p-4 bg-[var(--info-bg)] rounded-lg border border-[color:var(--info-border)]">
        <p className="text-sm text-[color:var(--info-text)]">
          <strong>{t("serialConfig.noteTitle")}</strong> {t("serialConfig.noteText")}
        </p>
      </div>
    </div>
  );
}
