// ui/src/dialogs/io-source-picker/DecoderPicker.tsx
//
// Footer for the Data Source dialog: lets the user attach a decoder (catalogue)
// to the session being created, in one step. Always enabled — the session simply
// carries the chosen decoder so any decode-aware app on it binds it via
// useSessionCatalog. When a decoder is selected it renders as a source-style row.

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { FileText, X } from "lucide-react";
import type { CatalogMetadata } from "../../api/catalog";
import { borderDefault, paddingCard, caption, textMedium } from "../../styles";
import { sectionHeader } from "../../styles/typography";
import { iconMd, iconXs } from "../../styles/spacing";
import CatalogPickerDialog from "../CatalogPickerDialog";
import { findCatalogByPath } from "../../utils/catalogUtils";

interface Props {
  catalogs: CatalogMetadata[];
  catalogPath: string | null;
  onSelect: (path: string | null) => void;
}

export default function DecoderPicker({ catalogs, catalogPath, onSelect }: Props) {
  const { t } = useTranslation("dialogs");
  const [pickerOpen, setPickerOpen] = useState(false);

  const selected = findCatalogByPath(catalogs, catalogPath);

  return (
    <>
      <div className={`${paddingCard} border-t ${borderDefault}`}>
        <div className={`${sectionHeader} mb-2`}>{t("ioSourcePicker.decoder.label")}</div>

        {catalogPath ? (
          // Selected decoder — styled like a selected source row.
          <div
            role="button"
            tabIndex={0}
            onClick={() => setPickerOpen(true)}
            className="w-full px-3 py-2 flex items-center gap-3 text-left rounded-lg transition-colors cursor-pointer hover:brightness-95 bg-[var(--status-info-bg)] border border-[color:var(--status-info-border)]"
          >
            <FileText className={`${iconMd} flex-shrink-0 text-[color:var(--status-info-text)]`} />
            <div className="flex-1 min-w-0">
              <div className={`${textMedium} truncate`}>
                {selected?.name ?? catalogPath}
              </div>
              {selected?.filename && (
                <div className={`${caption} text-[color:var(--text-muted)] truncate`}>
                  {selected.filename}
                </div>
              )}
            </div>
            <button
              onClick={(e) => { e.stopPropagation(); onSelect(null); }}
              title={t("ioSourcePicker.decoder.clear")}
              className="p-1 rounded hover:bg-[var(--hover-bg)] transition-colors text-[color:var(--text-muted)]"
            >
              <X className={iconXs} />
            </button>
          </div>
        ) : (
          // No decoder — unselected source-style row.
          <button
            onClick={() => setPickerOpen(true)}
            className="w-full px-3 py-2 flex items-center gap-3 text-left rounded-lg transition-colors cursor-pointer hover:bg-[var(--hover-bg)] border border-transparent"
          >
            <FileText className={`${iconMd} flex-shrink-0 text-[color:var(--text-muted)]`} />
            <span className="text-[color:var(--text-muted)] italic">
              {t("ioSourcePicker.decoder.none")}
            </span>
          </button>
        )}
      </div>

      <CatalogPickerDialog
        isOpen={pickerOpen}
        onClose={() => setPickerOpen(false)}
        catalogs={catalogs}
        selectedPath={catalogPath}
        onSelect={(path) => onSelect(path)}
        title={t("ioSourcePicker.decoder.pickerTitle")}
      />
    </>
  );
}
