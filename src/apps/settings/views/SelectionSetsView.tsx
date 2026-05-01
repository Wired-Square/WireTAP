// ui/src/apps/settings/views/SelectionSetsView.tsx

import { Star, Edit2, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { iconMd, flexRowGap2 } from "../../../styles/spacing";
import { cardDefault } from "../../../styles/cardStyles";
import { iconButtonHover, iconButtonHoverDanger } from "../../../styles/buttonStyles";
import type { SelectionSet } from "../../../utils/selectionSets";

type SelectionSetsViewProps = {
  selectionSets: SelectionSet[];
  onEditSelectionSet: (set: SelectionSet) => void;
  onDeleteSelectionSet: (set: SelectionSet) => void;
};

export default function SelectionSetsView({
  selectionSets,
  onEditSelectionSet,
  onDeleteSelectionSet,
}: SelectionSetsViewProps) {
  const { t, i18n } = useTranslation("settings");

  const formatDate = (timestamp: number) =>
    new Date(timestamp).toLocaleDateString(i18n.language, {
      year: "numeric",
      month: "short",
      day: "numeric",
    });

  return (
    <div className="space-y-6">
      <h2 className="text-xl font-semibold text-[color:var(--text-primary)]">
        {t("selectionSets.title")}
      </h2>

      {selectionSets.length === 0 ? (
        <div className="text-center py-12 text-[color:var(--text-muted)]">
          <Star className="w-12 h-12 mx-auto mb-4 opacity-50" />
          <p>{t("selectionSets.empty.heading")}</p>
          <p className="text-sm mt-2">{t("selectionSets.empty.description")}</p>
        </div>
      ) : (
        <div className="space-y-2">
          {selectionSets.map((set) => {
            const selected = set.selectedIds?.length ?? set.frameIds.length;
            const total = set.frameIds.length;
            return (
              <div
                key={set.id}
                className={`flex items-center justify-between p-4 ${cardDefault}`}
              >
                <div className="flex-1">
                  <div className="flex items-center gap-3">
                    <h4 className="font-medium text-[color:var(--text-primary)]">{set.name}</h4>
                  </div>
                  <div className="mt-1 text-sm text-[color:var(--text-muted)]">
                    {t("selectionSets.frameSummary", { count: total, selected, total })}
                    {" · "}
                    {t("selectionSets.createdAt", { date: formatDate(set.createdAt) })}
                    {set.lastUsedAt && ` · ${t("selectionSets.lastUsed", { date: formatDate(set.lastUsedAt) })}`}
                  </div>
                </div>
                <div className={flexRowGap2}>
                  <button
                    onClick={() => onEditSelectionSet(set)}
                    className={iconButtonHover}
                    title={t("selectionSets.actions.edit")}
                  >
                    <Edit2 className={`${iconMd} text-[color:var(--text-muted)]`} />
                  </button>
                  <button
                    onClick={() => onDeleteSelectionSet(set)}
                    className={iconButtonHoverDanger}
                    title={t("selectionSets.actions.delete")}
                  >
                    <Trash2 className={`${iconMd} text-[color:var(--text-red)]`} />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
