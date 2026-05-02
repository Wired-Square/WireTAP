// ui/src/components/CatalogButton.tsx
//
// Shared catalog display button. Shows the selected catalog name,
// or "No catalog" in italic when nothing is selected.

import { useTranslation } from "react-i18next";
import type { CatalogMetadata } from "../api/catalog";
import { buttonBase } from "../styles/buttonStyles";

export interface CatalogButtonProps {
  catalogs: CatalogMetadata[];
  catalogPath: string | null;
  onClick: () => void;
}

/** Normalise path separators for cross-platform comparison (Windows uses backslashes) */
const normalisePath = (p: string) => p.replace(/\\/g, "/");

export default function CatalogButton({
  catalogs,
  catalogPath,
  onClick,
}: CatalogButtonProps) {
  const { t } = useTranslation("common");
  const normalisedCatalogPath = catalogPath ? normalisePath(catalogPath) : null;
  const selectedCatalog = catalogs.find(
    (c) => normalisePath(c.path) === normalisedCatalogPath
  );
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
