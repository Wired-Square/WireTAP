// ui/src/apps/catalog/views/GenericChildrenView.tsx

import { useTranslation } from "react-i18next";
import { Trash2 } from "lucide-react";
import { iconMd } from "../../../styles/spacing";
import { caption, bgSurface, sectionHeaderText, hoverLight, emptyStateText } from "../../../styles";
import type { TomlNode } from "../types";
import { IconButton } from "../../../components/Button";
import { Badge } from "../../../components/Badge";

export type GenericChildrenViewProps = {
  selectedNode: TomlNode;
  onSelectNode: (node: TomlNode) => void;
  onRequestDelete?: (path: string[], label?: string) => void;
};

export default function GenericChildrenView({ selectedNode, onSelectNode, onRequestDelete }: GenericChildrenViewProps) {
  const { t } = useTranslation("catalog");
  const hasChildren = !!selectedNode.children && selectedNode.children.length > 0;
  const title = t("genericChildren.properties");

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className={sectionHeaderText}>
          {t("genericChildren.title", { label: title, count: selectedNode.children?.length ?? 0 })}
        </div>

        {onRequestDelete && (
          <IconButton
            onClick={() => onRequestDelete(selectedNode.path, selectedNode.key)}
            tone="danger"
            title={t("genericChildren.deleteTooltip")}
          >
            <Trash2 className={`${iconMd} text-danger`} />
          </IconButton>
        )}
      </div>

      {hasChildren ? (
        <div className="space-y-2">
          {selectedNode.children!.map((child, idx) => (
            <div
              key={idx}
              className={`p-3 ${bgSurface} rounded-lg ${hoverLight} cursor-pointer transition-colors`}
              onClick={() => onSelectNode(child)}
            >
              <div className="flex items-start justify-between gap-4">
                <div className="flex-1 min-w-0">
                  <div className="font-medium text-primary mb-1 flex items-center gap-2">
                    {child.type === "signal" && <span>⚡</span>}
                    {child.key}
                  </div>

                  {child.type === "signal" && child.metadata?.signal && (
                    <div className={`${caption} mt-1 space-y-0.5`}>
                      {child.metadata.signal.unit && <div>{t("genericChildren.unitLabel", { unit: child.metadata.signal.unit })}</div>}
                      {child.metadata.signal.factor !== undefined && <div>{t("genericChildren.factorLabel", { factor: child.metadata.signal.factor })}</div>}
                    </div>
                  )}

                  {child.type !== "signal" && child.children && (
                    <div className={caption}>
                      {t("genericChildren.itemsCount", { count: child.children.length })}
                    </div>
                  )}
                </div>

                <Badge size="lg">
                  {child.type === "section" && t("genericChildren.typeTable")}
                  {child.type === "signal" && t("genericChildren.typeSignal")}
                </Badge>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className={emptyStateText}>{t("genericChildren.noItems")}</div>
      )}
    </div>
  );
}
