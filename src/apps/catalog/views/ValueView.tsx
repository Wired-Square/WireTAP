// ui/src/apps/catalog/views/ValueView.tsx

import { useTranslation } from "react-i18next";
import type { TomlNode } from "../types";
import { monoBody, bgSecondary, sectionHeaderText } from "../../../styles";

export type ValueViewProps = {
  selectedNode: TomlNode;
};

export default function ValueView({ selectedNode }: ValueViewProps) {
  const { t } = useTranslation("catalog");
  return (
    <div className="space-y-4">
      <div className={`p-4 ${bgSecondary} rounded-lg`}>
        <div className={`${sectionHeaderText} mb-2`}>{t("valueView.label")}</div>
        <div className={monoBody}>
          {selectedNode.value === undefined ? "" : String(selectedNode.value)}
        </div>
      </div>
    </div>
  );
}
