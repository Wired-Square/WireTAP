// ui/src/components/CatalogButton.tsx
//
// Shared catalog display button. Shows the selected catalog name,
// or "No catalog" in italic when nothing is selected.

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
  const normalisedCatalogPath = catalogPath ? normalisePath(catalogPath) : null;
  const selectedCatalog = catalogs.find(
    (c) => normalisePath(c.path) === normalisedCatalogPath
  );
  const hasCatalog = !!selectedCatalog;
  const catalogName = selectedCatalog?.name || "No catalog";

  if (hasCatalog) {
    return (
      <button
        onClick={onClick}
        className={buttonBase}
        title="Select catalog"
      >
        <span className="max-w-32 truncate">{catalogName}</span>
      </button>
    );
  }

  return (
    <button
      onClick={onClick}
      className={buttonBase}
      title="Select catalog"
    >
      <span className="text-[color:var(--text-muted)] italic">No catalog</span>
    </button>
  );
}
