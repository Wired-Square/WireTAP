// ui/src/apps/settings/views/DashboardLayoutsView.tsx

import { LayoutGrid, Edit2, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { iconMd, flexRowGap2 } from "../../../styles/spacing";
import { cardDefault } from "../../../styles/cardStyles";
import { iconButtonHover, iconButtonHoverDanger } from "../../../styles/buttonStyles";
import type { DashboardLayout } from "../../../utils/dashboardLayouts";

type DashboardLayoutsViewProps = {
  dashboardLayouts: DashboardLayout[];
  onEditDashboardLayout: (layout: DashboardLayout) => void;
  onDeleteDashboardLayout: (layout: DashboardLayout) => void;
};

export default function DashboardLayoutsView({
  dashboardLayouts,
  onEditDashboardLayout,
  onDeleteDashboardLayout,
}: DashboardLayoutsViewProps) {
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
        {t("dashboardLayouts.title")}
      </h2>

      {dashboardLayouts.length === 0 ? (
        <div className="text-center py-12 text-[color:var(--text-muted)]">
          <LayoutGrid className="w-12 h-12 mx-auto mb-4 opacity-50" />
          <p>{t("dashboardLayouts.empty.heading")}</p>
          <p className="text-sm mt-2">{t("dashboardLayouts.empty.description")}</p>
        </div>
      ) : (
        <div className="space-y-2">
          {dashboardLayouts.map((layout) => (
            <div
              key={layout.id}
              className={`flex items-center justify-between p-4 ${cardDefault}`}
            >
              <div className="flex-1">
                <div className="flex items-center gap-3">
                  <h4 className="font-medium text-[color:var(--text-primary)]">{layout.name}</h4>
                </div>
                <div className="mt-1 text-sm text-[color:var(--text-muted)]">
                  {t("dashboardLayouts.panelCount", { count: layout.panels.length })}
                  {layout.catalogFilename && ` · ${layout.catalogFilename}`}
                  {" · "}
                  {t("dashboardLayouts.createdAt", { date: formatDate(layout.createdAt) })}
                  {layout.updatedAt !== layout.createdAt && ` · ${t("dashboardLayouts.updatedAt", { date: formatDate(layout.updatedAt) })}`}
                </div>
              </div>
              <div className={flexRowGap2}>
                <button
                  onClick={() => onEditDashboardLayout(layout)}
                  className={iconButtonHover}
                  title={t("dashboardLayouts.actions.edit")}
                >
                  <Edit2 className={`${iconMd} text-[color:var(--text-muted)]`} />
                </button>
                <button
                  onClick={() => onDeleteDashboardLayout(layout)}
                  className={iconButtonHoverDanger}
                  title={t("dashboardLayouts.actions.delete")}
                >
                  <Trash2 className={`${iconMd} text-[color:var(--text-red)]`} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
