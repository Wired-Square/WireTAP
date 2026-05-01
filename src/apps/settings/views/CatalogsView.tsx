// ui/src/apps/settings/views/CatalogsView.tsx
import { BookOpen, Copy, Edit2, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { iconMd, flexRowGap2 } from "../../../styles/spacing";
import { cardDefault } from "../../../styles/cardStyles";
import { emptyStateText, emptyStateHeading, emptyStateDescription } from "../../../styles/typography";
import { iconButtonHover, iconButtonHoverDanger } from "../../../styles/buttonStyles";
import { badgeMetadata } from "../../../styles/badgeStyles";
import type { CatalogFile } from "../stores/settingsStore";

type CatalogsViewProps = {
  catalogs: CatalogFile[];
  decoderDir: string;
  onDuplicateCatalog: (catalog: CatalogFile) => void;
  onEditCatalog: (catalog: CatalogFile) => void;
  onDeleteCatalog: (catalog: CatalogFile) => void;
};

export default function CatalogsView({
  catalogs,
  decoderDir,
  onDuplicateCatalog,
  onEditCatalog,
  onDeleteCatalog,
}: CatalogsViewProps) {
  const { t } = useTranslation("settings");

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold text-[color:var(--text-primary)]">
          {t("catalogs.title")}
        </h2>
      </div>

      {catalogs.length === 0 ? (
        <div className={`text-center py-12 ${emptyStateText}`}>
          <BookOpen className="w-12 h-12 mx-auto mb-4 opacity-50" />
          <p className={emptyStateHeading}>{t("catalogs.empty.heading")}</p>
          <p className={emptyStateDescription}>
            {t("catalogs.empty.description", {
              path: decoderDir || t("catalogs.empty.fallbackPath"),
            })}
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {catalogs.map((catalog) => (
            <div
              key={catalog.path}
              className={`flex items-center justify-between p-4 ${cardDefault}`}
            >
              <div className="flex-1">
                <div className="flex items-center gap-3">
                  <h3 className="font-medium text-[color:var(--text-primary)]">{catalog.name}</h3>
                  <span className={badgeMetadata}>
                    {catalog.filename}
                  </span>
                </div>
              </div>
              <div className={flexRowGap2}>
                <button
                  onClick={() => onDuplicateCatalog(catalog)}
                  className={iconButtonHover}
                  title={t("catalogs.actions.duplicate")}
                >
                  <Copy className={`${iconMd} text-[color:var(--text-secondary)]`} />
                </button>
                <button
                  onClick={() => onEditCatalog(catalog)}
                  className={iconButtonHover}
                  title={t("catalogs.actions.edit")}
                >
                  <Edit2 className={`${iconMd} text-[color:var(--text-secondary)]`} />
                </button>
                <button
                  onClick={() => onDeleteCatalog(catalog)}
                  className={iconButtonHoverDanger}
                  title={t("catalogs.actions.delete")}
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
