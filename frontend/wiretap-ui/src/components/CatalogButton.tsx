// ui/src/components/CatalogButton.tsx
//
// Shared catalog display button. Shows the selected catalog name,
// or "No catalog" in italic when nothing is selected.

import { useTranslation } from "react-i18next";
import type { CatalogMetadata } from "../api/catalog";
import { findCatalogByPath } from "../utils/catalogUtils";
import { Button } from "./Button";

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
      <Button
        onClick={onClick}
        title={t("catalogButton.selectCatalog")}
      >
        <span className="max-w-32 truncate">{catalogName}</span>
      </Button>
    );
  }

  return (
    <Button
      onClick={onClick}
      title={t("catalogButton.selectCatalog")}
    >
      <span className="text-muted italic">{t("catalogButton.noCatalog")}</span>
    </Button>
  );
}
