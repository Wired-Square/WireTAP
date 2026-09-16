// ui/src/apps/catalog/views/ArrayView.tsx

import { useTranslation } from "react-i18next";
import type { TomlNode } from "../types";
import { monoBody, bgSecondary, sectionHeaderText, emptyStateText } from "../../../styles";

export type ArrayViewProps = {
  selectedNode: TomlNode;
};

export default function ArrayView({ selectedNode }: ArrayViewProps) {
  const { t } = useTranslation("catalog");
  const items = selectedNode.metadata?.arrayItems || [];

  return (
    <div className="space-y-4">
      <div className={sectionHeaderText}>
        {t("arrayView.label", { count: items.length })}
      </div>
      <div className={`p-4 ${bgSecondary} rounded-lg`}>
        {items.length === 0 ? (
          <div className={emptyStateText}>{t("arrayView.noItems")}</div>
        ) : (
          <ul className="space-y-1">
            {items.map((item: any, idx: number) => (
              <li key={idx} className={monoBody}>
                {typeof item === "string" ? `"${item}"` : JSON.stringify(item)}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
