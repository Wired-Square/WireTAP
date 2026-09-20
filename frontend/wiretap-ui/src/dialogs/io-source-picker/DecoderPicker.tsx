// ui/src/dialogs/io-source-picker/DecoderPicker.tsx
//
// Footer for the Data Source dialog: lets the user attach a decoder (catalogue)
// to the session being created, in one step. Always enabled — the session simply
// carries the chosen decoder so any decode-aware app on it binds it via
// useSessionCatalog. When a decoder is selected it renders as a source-style row.

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { FileText, X } from "lucide-react";
import { borderDefault, caption, textMedium } from "../../styles";
import { sectionHeader } from "../../styles/typography";
import { iconMd, iconXs } from "../../styles/spacing";
import CatalogPickerDialog from "../catalog-picker";
import { useCatalogList } from "../../hooks/useCatalogList";
import { findCatalogByPath } from "../../utils/catalogUtils";
import { IconButton } from "../../components/Button";
import { Listbox, Option } from "../../components/Listbox";

interface Props {
  catalogPath: string | null;
  onSelect: (path: string | null) => void;
}

export default function DecoderPicker({ catalogPath, onSelect }: Props) {
  const { t } = useTranslation("dialogs");
  const catalogs = useCatalogList();
  const [pickerOpen, setPickerOpen] = useState(false);

  const selected = findCatalogByPath(catalogs, catalogPath);

  return (
    <>
      <div className={`p-4 border-t ${borderDefault}`}>
        <div className={`${sectionHeader} mb-2`}>{t("ioSourcePicker.decoder.label")}</div>

        <Listbox className="p-0">
        {catalogPath ? (
          <Option as="div" selected onClick={() => setPickerOpen(true)}>
            <FileText className={`${iconMd} flex-shrink-0 text-info`} />
            <div className="flex-1 min-w-0">
              <div className={`${textMedium} truncate`}>
                {selected?.name ?? catalogPath}
              </div>
              {selected?.filename && (
                <div className={`${caption} text-muted truncate`}>
                  {selected.filename}
                </div>
              )}
            </div>
            <IconButton
              onClick={(e) => { e.stopPropagation(); onSelect(null); }}
              title={t("ioSourcePicker.decoder.clear")}
              size="sm"
            >
              <X className={iconXs} />
            </IconButton>
          </Option>
        ) : (
          <Option onClick={() => setPickerOpen(true)}>
            <FileText className={`${iconMd} flex-shrink-0 text-muted`} />
            <span className="text-muted italic">
              {t("ioSourcePicker.decoder.none")}
            </span>
          </Option>
        )}
        </Listbox>
      </div>

      <CatalogPickerDialog
        isOpen={pickerOpen}
        onClose={() => setPickerOpen(false)}
        selectedPath={catalogPath}
        onSelect={(path) => onSelect(path)}
        title={t("ioSourcePicker.decoder.pickerTitle")}
      />
    </>
  );
}
