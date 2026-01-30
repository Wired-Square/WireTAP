// ui/src/apps/catalog/layout/CatalogToolbar.tsx

import { Check, ChevronDown, Download, FileText, Glasses, RotateCcw, Save, Settings, Star, X } from "lucide-react";
import { iconMd, iconSm } from "../../../styles/spacing";
import { disabledState } from "../../../styles";
import { buttonBase, iconButtonBase, toggleButtonClass } from "../../../styles/buttonStyles";
import type { EditMode } from "../types";
import type { CatalogMetadata } from "../../../api/catalog";
import AppTopBar from "../../../components/AppTopBar";

export type CatalogToolbarProps = {
  editMode: EditMode;
  catalogPath: string | null;
  hasUnsavedChanges: boolean;
  validationState: boolean | null; // null = not validated, true = valid, false = invalid

  // Catalog picker
  catalogs: CatalogMetadata[];
  defaultCatalogFilename?: string | null;

  onOpenPicker: () => void;
  onSave: () => void;
  onReload: () => void;
  onExport: () => void;
  onValidate: () => void;
  onToggleMode: () => void;
  onEditConfig: () => void;
};

export default function CatalogToolbar({
  editMode,
  catalogPath,
  hasUnsavedChanges,
  validationState,
  catalogs,
  defaultCatalogFilename,
  onOpenPicker,
  onSave,
  onReload,
  onExport,
  onValidate,
  onToggleMode,
  onEditConfig,
}: CatalogToolbarProps) {
  // Get catalog display info
  const selectedCatalog = catalogs.find((c) => c.path === catalogPath);
  const catalogName = selectedCatalog?.name || catalogPath?.split("/").pop() || "No catalog";
  const isDefaultCatalog = selectedCatalog?.filename === defaultCatalogFilename;

  // Validation button styling
  const validationButtonClass =
    validationState === true
      ? `p-1.5 rounded transition-colors bg-green-600 text-white hover:bg-green-700 ${disabledState}`
      : validationState === false
        ? `p-1.5 rounded transition-colors bg-red-600 text-white hover:bg-red-700 ${disabledState}`
        : iconButtonBase;

  // Save button styling (red when unsaved)
  const saveButtonClass = hasUnsavedChanges
    ? `p-1.5 rounded transition-colors bg-red-600 text-white hover:bg-red-700 shadow-md shadow-red-500/30 ${disabledState}`
    : iconButtonBase;

  return (
    <AppTopBar
      icon={FileText}
      iconColour="text-[color:var(--accent-primary)]"
      actions={
        <>
          {/* Settings Button */}
          <button
            onClick={onEditConfig}
            disabled={!catalogPath}
            title="Catalog configuration"
            className={iconButtonBase}
          >
            <Settings className={iconMd} />
          </button>
        </>
      }
    >
      {/* Catalog Picker Button */}
      <button
        onClick={onOpenPicker}
        className={buttonBase}
        title="Select catalog"
      >
        {isDefaultCatalog && (
          <Star className={`${iconSm} text-amber-500 flex-shrink-0`} fill="currentColor" />
        )}
        <span className="max-w-40 truncate">{catalogName}</span>
        <ChevronDown className={`${iconSm} flex-shrink-0 text-slate-400`} />
      </button>

      {/* Save */}
      <button
        onClick={onSave}
        disabled={!catalogPath}
        title={hasUnsavedChanges ? "Save changes (unsaved)" : "Save"}
        className={saveButtonClass}
      >
        <Save className={`${iconMd} ${hasUnsavedChanges ? "animate-pulse" : ""}`} />
      </button>

      {/* Reload */}
      <button
        onClick={onReload}
        disabled={!catalogPath}
        title="Reload from disk"
        className={iconButtonBase}
      >
        <RotateCcw className={iconMd} />
      </button>

      {/* Validate */}
      <button
        onClick={onValidate}
        disabled={!catalogPath}
        title={
          validationState === true
            ? "Valid - Click to re-validate"
            : validationState === false
              ? "Invalid - Click to see errors"
              : "Validate catalog"
        }
        className={validationButtonClass}
      >
        {validationState === false ? (
          <X className={iconMd} />
        ) : (
          <Check className={iconMd} />
        )}
      </button>

      {/* Export */}
      <button
        onClick={onExport}
        disabled={!catalogPath}
        title="Export catalog"
        className={iconButtonBase}
      >
        <Download className={iconMd} />
      </button>

      {/* Text mode toggle */}
      <button
        onClick={onToggleMode}
        disabled={!catalogPath}
        title={editMode === "ui" ? "Switch to Text Mode" : "Switch to GUI Mode"}
        className={toggleButtonClass(editMode === "text", "purple")}
      >
        <Glasses className={iconMd} fill={editMode === "text" ? "currentColor" : "none"} />
      </button>
    </AppTopBar>
  );
}
