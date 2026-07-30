// ui/src/dialogs/catalog-picker/CatalogPickerDialog.tsx
//
// The one catalogue picker, shared by the Catalog editor, Decoder, Dashboard,
// Query and the Data Source dialog's decoder section.
//
// It sources its own catalogue list and hosts the repositories dialog, so a host
// only says which catalogue is selected and what to do when one is picked. That
// is also what lets an import show up straight away: the write makes the backend
// broadcast `CatalogListChanged`, which `useCatalogList` reconciles from.
//
// Every way of getting a catalogue ends the same way — the new file is selected
// through `onSelect`, so each host binds it however it already does.

import { lazy, Suspense, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, FilePlus, GitBranch, Import, Search, X } from "lucide-react";
import Dialog from "../../components/Dialog";
import Input from "../../components/forms/Input";
import { openCatalog, importCatalog, importDbcWs } from "../../api/catalog";
import { pickFileToOpen } from "../../api/dialogs";
import { useCatalogList } from "../../hooks/useCatalogList";
import { useSettingsStore } from "../../apps/settings/stores/settingsStore";
import { buildCatalogPath, catalogBaseName } from "../../utils/catalogUtils";
import { iconMd, iconLg, iconSm } from "../../styles/spacing";
import { caption, textMedium, h3, borderDivider, hoverLight, emptyStateText } from "../../styles";
import { errorBoxCompact, panelFooter } from "../../styles/cardStyles";
import { dialogActionButton, primaryButtonBase } from "../../styles/buttonStyles";

// Its whole subtree — the share store and API — is dead weight in every panel
// that never opens it.
const RepositoryDialog = lazy(() => import("../catalog-share/RepositoryDialog"));

/** Below this many catalogues the list is short enough to scan without a filter. */
const SEARCH_THRESHOLD = 8;

const FILE_FILTERS = [
  { name: "Catalog Files", extensions: ["toml", "dbc"] },
  { name: "TOML Files", extensions: ["toml"] },
  { name: "DBC Files", extensions: ["dbc"] },
];

type Props = {
  isOpen: boolean;
  onClose: () => void;
  selectedPath: string | null;
  onSelect: (path: string) => void;
  title?: string;
  /** Hosting a create flow (the Catalog editor) — omitted elsewhere, hiding the chip. */
  onNewCatalog?: () => void;
};

/**
 * Hosts mount the picker permanently and flip `isOpen`, so the body — and its
 * catalogue-list subscription — is kept out of every panel that is not using it.
 */
export default function CatalogPickerDialog(props: Props) {
  return props.isOpen ? <CatalogPicker {...props} /> : null;
}

function CatalogPicker({ onClose, selectedPath, onSelect, title, onNewCatalog }: Props) {
  const { t } = useTranslation("dialogs");
  const catalogs = useCatalogList();

  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [repositoryOpen, setRepositoryOpen] = useState(false);

  const showSearch = catalogs.length > SEARCH_THRESHOLD;
  const needle = showSearch ? query.trim().toLowerCase() : "";
  const shown = needle
    ? catalogs.filter(
        (c) =>
          c.name.toLowerCase().includes(needle) || c.filename.toLowerCase().includes(needle),
      )
    : catalogs;

  const pick = (path: string) => {
    onSelect(path);
    onClose();
  };

  const handleImport = async () => {
    try {
      setError(null);
      const source = await pickFileToOpen({ filters: FILE_FILTERS });
      if (!source) return;

      // Rust names the file and de-collides it; DBC becomes TOML on the way in.
      const text = await openCatalog(source);
      const toml = source.toLowerCase().endsWith(".dbc") ? await importDbcWs(text) : text;
      pick(await importCatalog(catalogBaseName(source), toml));
    } catch (e) {
      setError(t("catalogPicker.errors.import", { message: String(e) }));
    }
  };

  const action = (primary: boolean) =>
    primary ? `flex-1 text-sm font-medium ${primaryButtonBase}` : `flex-1 ${dialogActionButton}`;

  return (
    <>
      {/* Hidden, not unmounted, while the repositories dialog it hosts is open. */}
      <Dialog isOpen={!repositoryOpen} onBackdropClick={onClose} maxWidth="max-w-md">
        <div className={`p-4 ${borderDivider} flex items-center justify-between`}>
          <h2 className={h3}>{title ?? t("catalogPicker.title")}</h2>
          <button
            onClick={onClose}
            aria-label={t("common:actions.close")}
            className={`p-1 rounded ${hoverLight} transition-colors`}
          >
            <X className={iconLg} />
          </button>
        </div>

        {showSearch && (
          <div className="px-4 pt-3">
            <div className="relative">
              <Search
                className={`${iconSm} absolute left-2.5 top-1/2 -translate-y-1/2 text-[color:var(--text-muted)]`}
              />
              <Input
                variant="simple"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t("catalogPicker.search")}
                className="pl-8"
                autoFocus
              />
            </div>
          </div>
        )}

        <div className="max-h-[50vh] overflow-y-auto">
          {shown.length === 0 ? (
            <div className={`p-4 ${emptyStateText}`}>
              {needle ? t("catalogPicker.noMatches") : t("catalogPicker.empty")}
            </div>
          ) : (
            // Rows read like the Data Source dialog's: tinted and bordered when
            // selected, not a bare background swap.
            <div className="px-3 py-2 space-y-1">
              {shown.map((catalog) => {
                const isSelected = catalog.path === selectedPath;
                return (
                  <button
                    key={catalog.path}
                    onClick={() => pick(catalog.path)}
                    className={`w-full px-3 py-2 flex items-center gap-3 text-left rounded-lg transition-colors ${
                      isSelected
                        ? "bg-[var(--status-info-bg)] border border-[color:var(--status-info-border)]"
                        : "hover:bg-[var(--hover-bg)] border border-transparent"
                    }`}
                  >
                    <div className="flex-1 min-w-0">
                      <span className={`${textMedium} truncate`}>{catalog.name}</span>
                      <div className={`${caption} truncate`}>{catalog.filename}</div>
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

        {error && <div className={`mx-3 mb-2 ${errorBoxCompact}`}>{error}</div>}

        <div className={`${panelFooter} flex gap-2`}>
          {onNewCatalog && (
            <button
              onClick={() => {
                onNewCatalog();
                onClose();
              }}
              title={t("catalogPicker.actionTitles.new")}
              className={action(true)}
            >
              <FilePlus className={iconMd} />
              {t("catalogPicker.actions.new")}
            </button>
          )}
          <button
            onClick={handleImport}
            title={t("catalogPicker.actionTitles.import")}
            className={action(!onNewCatalog)}
          >
            <Import className={iconMd} />
            {t("catalogPicker.actions.import")}
          </button>
          <button
            onClick={() => setRepositoryOpen(true)}
            title={t("catalogPicker.actionTitles.repository")}
            className={action(false)}
          >
            <GitBranch className={iconMd} />
            {t("catalogPicker.actions.repository")}
          </button>
        </div>
      </Dialog>

      {repositoryOpen && (
        <Suspense fallback={null}>
          <RepositoryDialog
            isOpen
            onClose={() => setRepositoryOpen(false)}
            onImported={(filename) => {
              setRepositoryOpen(false);
              pick(buildCatalogPath(filename, useSettingsStore.getState().locations.decoderDir));
            }}
          />
        </Suspense>
      )}
    </>
  );
}
