// ui/src/apps/catalog/layout/CatalogToolbar.tsx

import { Check, ChevronDown, Download, Glasses, RotateCcw, Save, Settings, X } from "lucide-react";
import * as ShareIcon from "../../../components/catalogIcons";
import { useTranslation } from "react-i18next";
import { iconMd, iconSm } from "../../../styles/spacing";
import type { EditMode } from "../types";
import type { CatalogMetadata } from "../../../api/catalog";
import { findCatalogByPath } from "../../../utils/catalogUtils";
import AppTopBar from "../../../components/AppTopBar";
import OverflowMenu from "../../../components/OverflowMenu";
import { Button, IconButton } from "../../../components/Button";

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

  const validationTone = validationState === true ? "success" : validationState === false ? "danger" : "neutral";

  return (
    <AppTopBar
      app="catalog-editor"
      frameIdFormat
      actions={
        <>
          {/* Settings Button */}
          <IconButton
            onClick={onEditConfig}
            disabled={!catalogPath}
            title={t("toolbar.configuration")}
            variant="surface"
          >
            <Settings className={iconMd} />
          </IconButton>
        </>
      }
    >
      {/* Catalog Picker Button */}
      <Button
        onClick={onOpenPicker}
        title={t("toolbar.selectCatalog")}
      >
        <span className="max-w-40 truncate">{catalogName}</span>
        <ChevronDown className={`${iconSm} flex-shrink-0 text-slate-400`} />
      </Button>

      {/* Save */}
      <IconButton
        onClick={onSave}
        disabled={!catalogPath}
        title={hasUnsavedChanges ? t("toolbar.saveUnsaved") : t("toolbar.save")}
        variant={hasUnsavedChanges ? "solid" : "surface"}
        tone={hasUnsavedChanges ? "danger" : "neutral"}
        className={hasUnsavedChanges ? "shadow-md shadow-red-500/30" : ""}
      >
        <Save className={`${iconMd} ${hasUnsavedChanges ? "animate-pulse" : ""}`} />
      </IconButton>

      {/* Reload */}
      <IconButton
        onClick={onReload}
        disabled={!catalogPath}
        title={t("toolbar.reload")}
        variant="surface"
      >
        <RotateCcw className={iconMd} />
      </IconButton>

      {/* Validate */}
      <IconButton
        onClick={onValidate}
        disabled={!catalogPath}
        title={
          validationState === true
            ? t("toolbar.validateValid")
            : validationState === false
              ? t("toolbar.validateInvalid")
              : t("toolbar.validate")
        }
        variant={validationTone === "neutral" ? "surface" : "solid"}
        tone={validationTone}
      >
        {validationState === false ? (
          <X className={iconMd} />
        ) : (
          <Check className={iconMd} />
        )}
      </IconButton>

      {/* Export */}
      <IconButton
        onClick={onExport}
        disabled={!catalogPath}
        title={t("toolbar.export")}
        variant="surface"
      >
        <Download className={iconMd} />
      </IconButton>

      {/* Publish to Git — the saved file is what gets published, so unsaved
          changes disable it rather than silently publishing stale bytes. */}
      {onPublish && (
        <IconButton
          onClick={onPublish}
          disabled={!catalogPath || hasUnsavedChanges}
          title={hasUnsavedChanges ? t("toolbar.publishUnsaved") : t("toolbar.publish")}
          variant="surface"
        >
          <ShareIcon.Push className={iconMd} />
        </IconButton>
      )}

      {/* Review an upstream update — only offered for a tracked catalogue that
          actually has one waiting. One repository acts straight away; several offer
          the choice behind the same glyph, so the button never changes its meaning. */}
      {onReviewUpdate &&
        updatableSources.length > 0 &&
        (updatableSources.length === 1 ? (
          <IconButton
            onClick={() => onReviewUpdate(updatableSources[0].id)}
            title={t("toolbar.reviewUpdateFrom", { repo: updatableSources[0].repoLabel })}
            variant="surface"
          >
            <ShareIcon.Diff className={iconMd} />
          </IconButton>
        ) : (
          <OverflowMenu
            title={t("toolbar.reviewUpdateChoose", { count: updatableSources.length })}
            trigger={<ShareIcon.Diff className={iconMd} />}
            variant="surface"
            items={updatableSources.map((source) => ({
              label: t("toolbar.reviewUpdateFrom", { repo: source.repoLabel }),
              icon: ShareIcon.Diff,
              onClick: () => onReviewUpdate(source.id),
            }))}
          />
        ))}

      {/* Text mode toggle */}
      <IconButton
        onClick={onToggleMode}
        disabled={!catalogPath}
        title={editMode === "ui" ? t("toolbar.switchToText") : t("toolbar.switchToGui")}
        variant="surface"
        tone="purple"
        pressed={editMode === "text"}
      >
        <Glasses
          className={`${iconMd} ${hasUnsavedChanges && editMode !== "text" ? "animate-pulse" : ""}`}
          fill={editMode === "text" ? "currentColor" : "none"}
        />
      </IconButton>
    </AppTopBar>
  );
}
