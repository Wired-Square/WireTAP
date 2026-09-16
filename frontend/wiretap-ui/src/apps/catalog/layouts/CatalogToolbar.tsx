// ui/src/apps/catalog/layout/CatalogToolbar.tsx

import { Check, ChevronDown, Download, FileText, Glasses, RotateCcw, Save, Settings, X } from "lucide-react";
import * as ShareIcon from "../../../components/catalogIcons";
import { useTranslation } from "react-i18next";
import { iconMd, iconSm } from "../../../styles/spacing";
import { disabledState } from "../../../styles";
import { buttonBase, iconButtonBase, toggleButtonClass } from "../../../styles/buttonStyles";
import type { EditMode } from "../types";
import type { CatalogMetadata } from "../../../api/catalog";
import { findCatalogByPath } from "../../../utils/catalogUtils";
import AppTopBar from "../../../components/AppTopBar";
import OverflowMenu from "../../../components/OverflowMenu";

export type CatalogToolbarProps = {
  editMode: EditMode;
  catalogPath: string | null;
  hasUnsavedChanges: boolean;
  validationState: boolean | null; // null = not validated, true = valid, false = invalid

  // Catalog picker
  catalogs: CatalogMetadata[];

  onOpenPicker: () => void;
  onSave: () => void;
  onReload: () => void;
  onExport: () => void;
  onValidate: () => void;
  onToggleMode: () => void;
  onEditConfig: () => void;
  /** Publish to a Git repository. Publishes the saved bytes, so unsaved blocks it. */
  onPublish?: () => void;
  /**
   * Repositories with an update waiting for the open catalogue. Empty when it is not
   * tracked, or when every repository holding it is current.
   *
   * A list rather than one id: a catalogue tracked against two repositories can have
   * two updates waiting, and picking whichever came first would review one of them at
   * random and leave no way to reach the other.
   */
  updatableSources?: { id: string; repoLabel: string }[];
  onReviewUpdate?: (catalogId: string) => void;
};

export default function CatalogToolbar({
  editMode,
  catalogPath,
  hasUnsavedChanges,
  validationState,
  catalogs,
  onOpenPicker,
  onSave,
  onReload,
  onExport,
  onValidate,
  onToggleMode,
  onEditConfig,
  onPublish,
  updatableSources = [],
  onReviewUpdate,
}: CatalogToolbarProps) {
  const { t } = useTranslation("catalog");
  // Get catalog display info
  const selectedCatalog = findCatalogByPath(catalogs, catalogPath);
  const catalogName = selectedCatalog?.name || catalogPath?.split("/").pop() || t("toolbar.noCatalog");

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
      frameIdFormat
      actions={
        <>
          {/* Settings Button */}
          <button
            onClick={onEditConfig}
            disabled={!catalogPath}
            title={t("toolbar.configuration")}
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
        title={t("toolbar.selectCatalog")}
      >
        <span className="max-w-40 truncate">{catalogName}</span>
        <ChevronDown className={`${iconSm} flex-shrink-0 text-slate-400`} />
      </button>

      {/* Save */}
      <button
        onClick={onSave}
        disabled={!catalogPath}
        title={hasUnsavedChanges ? t("toolbar.saveUnsaved") : t("toolbar.save")}
        className={saveButtonClass}
      >
        <Save className={`${iconMd} ${hasUnsavedChanges ? "animate-pulse" : ""}`} />
      </button>

      {/* Reload */}
      <button
        onClick={onReload}
        disabled={!catalogPath}
        title={t("toolbar.reload")}
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
            ? t("toolbar.validateValid")
            : validationState === false
              ? t("toolbar.validateInvalid")
              : t("toolbar.validate")
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
        title={t("toolbar.export")}
        className={iconButtonBase}
      >
        <Download className={iconMd} />
      </button>

      {/* Publish to Git — the saved file is what gets published, so unsaved
          changes disable it rather than silently publishing stale bytes. */}
      {onPublish && (
        <button
          onClick={onPublish}
          disabled={!catalogPath || hasUnsavedChanges}
          title={hasUnsavedChanges ? t("toolbar.publishUnsaved") : t("toolbar.publish")}
          className={iconButtonBase}
        >
          <ShareIcon.Push className={iconMd} />
        </button>
      )}

      {/* Review an upstream update — only offered for a tracked catalogue that
          actually has one waiting. One repository acts straight away; several offer
          the choice behind the same glyph, so the button never changes its meaning. */}
      {onReviewUpdate &&
        updatableSources.length > 0 &&
        (updatableSources.length === 1 ? (
          <button
            onClick={() => onReviewUpdate(updatableSources[0].id)}
            title={t("toolbar.reviewUpdateFrom", { repo: updatableSources[0].repoLabel })}
            className={iconButtonBase}
          >
            <ShareIcon.Diff className={iconMd} />
          </button>
        ) : (
          <OverflowMenu
            title={t("toolbar.reviewUpdateChoose", { count: updatableSources.length })}
            trigger={<ShareIcon.Diff className={iconMd} />}
            className={iconButtonBase}
            items={updatableSources.map((source) => ({
              label: t("toolbar.reviewUpdateFrom", { repo: source.repoLabel }),
              icon: ShareIcon.Diff,
              onClick: () => onReviewUpdate(source.id),
            }))}
          />
        ))}

      {/* Text mode toggle */}
      <button
        onClick={onToggleMode}
        disabled={!catalogPath}
        title={editMode === "ui" ? t("toolbar.switchToText") : t("toolbar.switchToGui")}
        className={toggleButtonClass(editMode === "text", "purple")}
      >
        <Glasses
          className={`${iconMd} ${hasUnsavedChanges && editMode !== "text" ? "animate-pulse" : ""}`}
          fill={editMode === "text" ? "currentColor" : "none"}
        />
      </button>
    </AppTopBar>
  );
}
