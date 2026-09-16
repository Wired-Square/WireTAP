// ui/src/apps/catalog/views/EmptySelectionView.tsx

import { useTranslation } from "react-i18next";
import { FileText } from "lucide-react";
import { textMuted } from "../../../styles/colourTokens";
import { iconXl } from "../../../styles/spacing";
import { emptyStateContainer, emptyStateText, emptyStateHeading, emptyStateDescription } from "../../../styles/typography";

export type EmptySelectionViewProps = {
  title?: string;
  subtitle?: string;
};

export default function EmptySelectionView({
  title,
  subtitle,
}: EmptySelectionViewProps) {
  const { t } = useTranslation("catalog");
  return (
    <div className={`h-full ${emptyStateContainer}`}>
      <FileText className={`${iconXl} ${textMuted} mb-4 opacity-50`} />
      <div className={emptyStateText}>
        <p className={emptyStateHeading}>{title ?? t("emptySelection.title")}</p>
        <p className={emptyStateDescription}>{subtitle ?? t("emptySelection.subtitle")}</p>
      </div>
    </div>
  );
}
