// ui/src/apps/decoder/dialogs/CatalogPickerDialog.tsx

import { Check, Star, X } from "lucide-react";
import { iconMd, iconSm, iconLg, flexRowGap2 } from "../../../styles/spacing";
import { caption, textMedium, borderDivider, hoverLight, bgSurface } from "../../../styles";
import Dialog from "../../../components/Dialog";
import type { CatalogMetadata } from "../../../api/catalog";

type Props = {
  isOpen: boolean;
  onClose: () => void;
  catalogs: CatalogMetadata[];
  selectedPath: string | null;
  defaultFilename?: string | null;
  onSelect: (path: string) => void;
};

export default function CatalogPickerDialog({
  isOpen,
  onClose,
  catalogs,
  selectedPath,
  defaultFilename,
  onSelect,
}: Props) {
  const handleSelect = (path: string) => {
    onSelect(path);
    onClose();
  };

  return (
    <Dialog isOpen={isOpen} onBackdropClick={onClose} maxWidth="max-w-sm">
      <div className={`${bgSurface} rounded-xl shadow-xl overflow-hidden`}>
        <div className={`p-4 ${borderDivider} flex items-center justify-between`}>
          <h2 className="text-lg font-semibold text-[color:var(--text-primary)]">
            Select Decoder Catalog
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
      </div>
    </Dialog>
  );
}
