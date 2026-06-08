// ui/src/components/CatalogButton.tsx
//
// Shared catalog display button. Shows the selected catalog name,
// or "No catalog" in italic when nothing is selected.

import { useTranslation } from "react-i18next";
import type { CatalogMetadata } from "../api/catalog";
import { buttonBase } from "../styles/buttonStyles";
import { findCatalogByPath } from "../utils/catalogUtils";

export interface CatalogButtonProps {
  catalogs: CatalogMetadata[];
  catalogPath: string | null;
  onClick: () => void;
}

export default function CatalogButton({
  catalogs,
  catalogPath,
  onClick,
}: CatalogButtonProps) {
  const { t } = useTranslation("common");
  const selectedCatalog = findCatalogByPath(catalogs, catalogPath);
  const hasCatalog = !!selectedCatalog;
  const catalogName = selectedCatalog?.name || t("catalogButton.noCatalog");

  if (hasCatalog) {
    return (
      <button
        onClick={onClick}
        className={buttonBase}
        title={t("catalogButton.selectCatalog")}
      >
        <span className="max-w-32 truncate">{catalogName}</span>
      </button>
    );
  }

  return (
    <button
      onClick={onClick}
      className={buttonBase}
      title={t("catalogButton.selectCatalog")}
    >
      <span className="text-[color:var(--text-muted)] italic">{t("catalogButton.noCatalog")}</span>
    </button>
  );
}
