// ui/src/apps/catalog/views/SerialConfigView.tsx

import { useTranslation } from "react-i18next";
import { Cable, Pencil } from "lucide-react";
import { iconMd, iconLg } from "../../../styles/spacing";
import { caption, labelSmallMuted, monoBody, bgSurface } from "../../../styles";
import type { TomlNode } from "../types";
import { IconButton } from "../../../components/Button";

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
          <div className="p-2 bg-purple rounded-lg">
            <Cable className={`${iconLg} text-purple`} />
          </div>
          <div>
            <div className="text-lg font-bold text-primary">
              {t("serialConfig.title")}
            </div>
            <p className="text-sm text-muted">
              {t("serialConfig.subtitle")}
            </p>
          </div>
        </div>
        {onEditConfig && (
          <IconButton
            onClick={onEditConfig}
            title={t("serialConfig.editTooltip")}
          >
            <Pencil className={`${iconMd} text-secondary`} />
          </IconButton>
        )}
      </div>

      {/* Property cards */}
      <div className="grid grid-cols-2 gap-4">
        <div className={`p-4 ${bgSurface} rounded-lg col-span-2`}>
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
      <div className="p-4 bg-info rounded-lg border border-info">
        <p className="text-sm text-info">
          <strong>{t("serialConfig.noteTitle")}</strong> {t("serialConfig.noteText")}
        </p>
      </div>
    </div>
  );
}
