// ui/src/apps/catalog/dialogs/CatalogPickerDialog.tsx

import { Check, FilePlus, Import, Star, X } from "lucide-react";
import { iconMd, iconSm, iconLg, flexRowGap2 } from "../../../styles/spacing";
import { caption, textMedium } from "../../../styles/typography";
import { borderDivider, hoverLight, bgSurface, dialogOptionButton } from "../../../styles";
import Dialog from "../../../components/Dialog";
import type { CatalogMetadata } from "../../../api/catalog";
import { pickFileToOpen } from "../../../api/dialogs";
import { openCatalog } from "../../../api/catalog";

type Props = {
  isOpen: boolean;
  onClose: () => void;
  catalogs: CatalogMetadata[];
  selectedPath: string | null;
  defaultFilename?: string | null;
  onSelect: (path: string) => void;
  onImport?: (path: string, content: string) => void;
  onImportError?: (message: string) => void;
  onNewCatalog?: () => void;
};

export default function CatalogPickerDialog({
  isOpen,
  onClose,
  catalogs,
  selectedPath,
  defaultFilename,
  onSelect,
  onImport,
  onImportError,
  onNewCatalog,
}: Props) {
  const handleSelect = (path: string) => {
    onSelect(path);
    onClose();
  };

  const handleImport = async () => {
    try {
      const selected = await pickFileToOpen({
        filters: [
          { name: "Catalog Files", extensions: ["toml", "dbc"] },
          { name: "TOML Files", extensions: ["toml"] },
          { name: "DBC Files", extensions: ["dbc"] },
        ],
      });

      if (selected) {
        if (selected.endsWith(".dbc")) {
          // DBC import not yet supported
          onImportError?.("DBC import is not yet supported. Only TOML files can be imported.");
          return;
        }

        // Import TOML file
        const content = await openCatalog(selected);
        onImport?.(selected, content);
        onClose();
      }
    } catch (error) {
      console.error("Failed to import file:", error);
      onImportError?.(`Failed to import file: ${error}`);
    }
  };

  return (
    <Dialog isOpen={isOpen} onBackdropClick={onClose} maxWidth="max-w-sm">
      <div className={`${bgSurface} rounded-xl shadow-xl overflow-hidden`}>
        <div className={`p-4 ${borderDivider} flex items-center justify-between`}>
          <h2 className="text-lg font-semibold text-[color:var(--text-primary)]">
            Select Catalog
          </h2>
          <button
            onClick={onClose}
            className={`p-1 rounded ${hoverLight} transition-colors`}
          >
            <X className={iconLg} />
          </button>
        </div>
        <div className="max-h-[50vh] overflow-y-auto">
          {catalogs.length === 0 ? (
            <div className="p-4 text-sm text-[color:var(--text-muted)]">
              No catalogs found. Add TOML catalog files to your decoder directory.
            </div>
          ) : (
            <div className="py-1">
              {catalogs.map((catalog) => {
                const isSelected = catalog.path === selectedPath;
                const isDefault = catalog.filename === defaultFilename;
                return (
                  <button
                    key={catalog.path}
                    onClick={() => handleSelect(catalog.path)}
                    className={`w-full px-4 py-2.5 flex items-center gap-3 text-left ${hoverLight} transition-colors ${
                      isSelected ? "bg-[var(--bg-surface)]" : ""
                    }`}
                  >
                    <div className="flex-1 min-w-0">
                      <div className={flexRowGap2}>
                        {isDefault && (
                          <Star className={`${iconSm} text-amber-500 flex-shrink-0`} fill="currentColor" />
                        )}
                        <span className={`${textMedium} truncate`}>
                          {catalog.name}
                        </span>
                      </div>
                      <div className={`${caption} truncate`}>
                        {catalog.filename}
                      </div>
                    </div>
                    {isSelected && (
                      <Check className={`${iconMd} text-[color:var(--text-success)] flex-shrink-0`} />
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* Action buttons */}
        {(onNewCatalog || onImport) && (
          <div className="p-3 border-t border-[color:var(--border-default)] flex gap-2">
            {onNewCatalog && (
              <button
                onClick={() => {
                  onNewCatalog();
                  onClose();
                }}
                className={dialogOptionButton}
              >
                <FilePlus className={iconMd} />
                New Catalog
              </button>
            )}
            {onImport && (
              <button
                onClick={handleImport}
                className={dialogOptionButton}
              >
                <Import className={iconMd} />
                Import from File
              </button>
            )}
          </div>
        )}
      </div>
    </Dialog>
  );
}
