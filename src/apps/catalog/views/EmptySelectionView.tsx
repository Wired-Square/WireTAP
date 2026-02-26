// ui/src/apps/catalog/views/EmptySelectionView.tsx

import { FileText } from "lucide-react";
import { textMuted } from "../../../styles/colourTokens";
import { iconXl } from "../../../styles/spacing";
import { emptyStateContainer, emptyStateText, emptyStateHeading, emptyStateDescription } from "../../../styles/typography";

export type EmptySelectionViewProps = {
  title?: string;
  subtitle?: string;
};

export default function EmptySelectionView({
  title = "Select a node",
  subtitle = "Select a node from the structure tree to view its content",
}: EmptySelectionViewProps) {
  return (
    <div className={`h-full ${emptyStateContainer}`}>
      <FileText className={`${iconXl} ${textMuted} mb-4 opacity-50`} />
      <div className={emptyStateText}>
        <p className={emptyStateHeading}>{title}</p>
        <p className={emptyStateDescription}>{subtitle}</p>
      </div>
    </div>
  );
}
