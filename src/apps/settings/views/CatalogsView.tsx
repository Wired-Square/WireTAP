// ui/src/apps/settings/views/CatalogsView.tsx
import { BookOpen } from "lucide-react";
import * as ShareIcon from "../../../components/catalogIcons";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { openUrl } from "@tauri-apps/plugin-opener";
import { iconMd, flexRowGap2 } from "../../../styles/spacing";
import { cardDefault } from "../../../styles/cardStyles";
import {
  emptyStateText,
  emptyStateHeading,
  emptyStateDescription,
} from "../../../styles/typography";
import { badgeMetadata } from "../../../styles/badgeStyles";
import { caption, textDanger } from "../../../styles";
import { SecondaryButton } from "../../../components/forms";
import OverflowMenu, { type OverflowMenuItem } from "../../../components/OverflowMenu";
import type { CatalogFile } from "../stores/settingsStore";
import { revealRepoClone } from "../../../api/catalogShare";
import { useCatalogShareStore } from "../../../stores/catalogShareStore";
import { useCatalogSources, type CatalogWithSource } from "../../../hooks/useCatalogSources";
import { hasLocalChanges, hasRemoteChanges } from "../../../utils/catalogSync";
import { CatalogSyncBadge } from "../../../components/catalogSyncPresentation";
import type { CatalogSyncStatus } from "../../../api/catalogShare";

type CatalogsViewProps = {
  decoderDir: string;
  onDuplicateCatalog: (catalog: CatalogFile) => void;
  onEditCatalog: (catalog: CatalogFile) => void;
  onDeleteCatalog: (catalog: CatalogFile) => void;
  /** Opens the repository dialog (browse, import, saved repositories). */
  onOpenRepositories?: () => void;
  /** Opens the push dialog for one catalogue. */
  onPublishCatalog?: (catalog: CatalogFile) => void;
  /** Opens the GitHub account dialog. */
  onManageAccount?: () => void;
  /** Opens the diff review for one tracked catalogue. */
  onReviewUpdate: (catalogId: string) => void;
  /** iOS has no file manager to reveal a clone into, so that action is hidden. */
  isIOS?: boolean;
};

export default function CatalogsView({
  decoderDir,
  onDuplicateCatalog,
  onEditCatalog,
  onDeleteCatalog,
  onOpenRepositories,
  onPublishCatalog,
  onManageAccount,
  onReviewUpdate,
  isIOS = false,
}: CatalogsViewProps) {
  const { t } = useTranslation("settings");

  // Backend-authoritative list joined with provenance, both reconciled off the
  // same CatalogListChanged push — so an imported catalogue never appears without
  // its source badge.
  const catalogs = useCatalogSources();
  const tracked = useCatalogShareStore((s) => s.tracked);
  const login = useCatalogShareStore((s) => s.login);
  const hasToken = useCatalogShareStore((s) => s.hasToken);
  const forgetSource = useCatalogShareStore((s) => s.forgetSource);
  const checkPrStatus = useCatalogShareStore((s) => s.checkPrStatus);
  const updates = useCatalogShareStore((s) => s.updates);
  const runUpdateCheck = useCatalogShareStore((s) => s.runUpdateCheck);
  const pullCatalog = useCatalogShareStore((s) => s.pullCatalog);
  const pulling = useCatalogShareStore((s) => s.pulling);
  const pullErrors = useCatalogShareStore((s) => s.pullErrors);
  // Transient, per-action feedback that is not an error — a pull that found nothing
  // to take, or a file deleted upstream.
  const [notice, setNotice] = useState<string | null>(null);

  /**
   * Pull, and open the diff only when the backend says there is a decision to make.
   * A clean fast-forward is applied with no dialog at all — that is the whole point
   * of the one-click path.
   */
  const handlePull = async (catalogId: string) => {
    const outcome = await pullCatalog(catalogId);
    if (outcome?.kind === "needsReview") onReviewUpdate(catalogId);
    // The file is gone from the repository. Say so, and point at the action that
    // resolves it — silence here reads as a broken button.
    if (outcome?.kind === "goneUpstream") setNotice(t("catalogs.goneUpstream"));
  };

  const menuItems = (
    catalog: CatalogWithSource,
    status: CatalogSyncStatus,
  ): OverflowMenuItem[] => {
    const { source } = catalog;
    const isPulling = !!source && pulling.includes(source.id);
    // Declarative, with `&&` guards filtered out — the shape of the menu is readable
    // at a glance rather than assembled by a run of conditional pushes.
    return [
      source && {
        // Labelled from the same derived status the badge shows, so a row reading
        // "Diverged" offers to review rather than promising a clean pull.
        label: hasRemoteChanges(status)
          ? t("catalogs.actions.pullAvailable")
          : t("catalogs.actions.pull"),
        icon: isPulling ? ShareIcon.Busy : ShareIcon.Pull,
        disabled: isPulling,
        onClick: () => void handlePull(source.id),
      },
      onPublishCatalog && {
        label: hasLocalChanges(status)
          ? t("catalogs.actions.pushChanges")
          : t("catalogs.actions.push"),
        icon: ShareIcon.Push,
        // Nothing to send is not a reason to hide it — pushing an in-sync catalogue
        // to a *different* repository is a normal thing to want.
        onClick: () => onPublishCatalog(catalog),
      },
      source?.webUrl && {
        label: t("catalogs.actions.openRepo"),
        icon: ShareIcon.GitHub,
        onClick: () => void openUrl(source.webUrl!),
      },
      source?.prNumber && {
        label: t("catalogs.actions.viewPr", { number: source.prNumber }),
        icon: ShareIcon.PullRequest,
        onClick: () => {
          void checkPrStatus(source.id);
          if (source.prUrl) void openUrl(source.prUrl);
        },
      },
      // Desktop only: there is no file manager to reveal into on iOS.
      source &&
        !isIOS && {
          label: t("catalogs.actions.revealClone"),
          icon: ShareIcon.RevealClone,
          // Says so rather than appearing to do nothing when nothing is cloned.
          onClick: () =>
            void revealRepoClone(source.repoId).then((revealed) => {
              if (!revealed) setNotice(t("catalogs.notCloned"));
            }),
        },
      { separator: true },
      {
        label: t("catalogs.actions.duplicate"),
        icon: ShareIcon.Duplicate,
        onClick: () => onDuplicateCatalog(catalog),
      },
      { label: t("catalogs.actions.edit"), icon: ShareIcon.Edit, onClick: () => onEditCatalog(catalog) },
      source && {
        label: t("catalogs.actions.forget"),
        icon: ShareIcon.Forget,
        onClick: () => void forgetSource(source.id),
      },
      {
        label: t("catalogs.actions.delete"),
        icon: ShareIcon.Delete,
        danger: true,
        onClick: () => onDeleteCatalog(catalog),
      },
    ].filter(Boolean) as OverflowMenuItem[];
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <h2 className="text-xl font-semibold text-[color:var(--text-primary)]">
          {t("catalogs.title")}
        </h2>
        <div className={flexRowGap2}>
          {onOpenRepositories && (
            <SecondaryButton onClick={onOpenRepositories}>
              <ShareIcon.Repository className={iconMd} />
              {t("catalogs.repository")}
            </SecondaryButton>
          )}
          {tracked.length > 0 && (
            <SecondaryButton onClick={() => void runUpdateCheck()} disabled={updates.checking}>
              {updates.checking ? (
                <ShareIcon.Busy className={`${iconMd} animate-spin`} />
              ) : (
                <ShareIcon.CheckUpdates className={iconMd} />
              )}
              {t("catalogs.checkUpdates")}
            </SecondaryButton>
          )}
          {onManageAccount && (
            <SecondaryButton onClick={onManageAccount}>
              <ShareIcon.GitHub className={iconMd} />
              {hasToken && login
                ? t("catalogs.account.connected", { login })
                : t("catalogs.account.connect")}
            </SecondaryButton>
          )}
        </div>
      </div>

      <p className={caption}>{t("catalogs.sharingHint")}</p>

      {updates.lastResult && (
        <p className={caption}>
          {updates.lastResult.updatesAvailable > 0
            ? t("catalogs.updateSummary", {
                count: updates.lastResult.updatesAvailable,
                repos: updates.lastResult.reposChecked,
              })
            : t("catalogs.updateSummaryNone", { repos: updates.lastResult.reposChecked })}
          {updates.lastResult.failures.length > 0 && (
            <span
              title={updates.lastResult.failures
                .map((f) => `${f.repoLabel}: ${f.message}`)
                .join("\n")}
            >
              {` · ${t("catalogs.updateFailures", {
                count: updates.lastResult.failures.length,
              })}`}
            </span>
          )}
        </p>
      )}
      {updates.checkError && (
        <p className={`${caption} ${textDanger}`}>{updates.checkError.message}</p>
      )}
      {notice && <p className={caption}>{notice}</p>}

      {catalogs.length === 0 ? (
        <div className={`text-center py-12 ${emptyStateText}`}>
          <BookOpen className="w-12 h-12 mx-auto mb-4 opacity-50" />
          <p className={emptyStateHeading}>{t("catalogs.empty.heading")}</p>
          <p className={emptyStateDescription}>
            {t("catalogs.empty.description", {
              path: decoderDir || t("catalogs.empty.fallbackPath"),
            })}
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {catalogs.map((catalog) => {
            const { source } = catalog;
            const status = catalog.syncStatus;
            return (
              <div
                key={catalog.path}
                className={`flex items-center justify-between p-4 ${cardDefault}`}
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-3 flex-wrap">
                    <h3 className="font-medium text-[color:var(--text-primary)]">
                      {catalog.name}
                    </h3>
                    <span className={badgeMetadata}>{catalog.filename}</span>
                    <CatalogSyncBadge status={status} />
                  </div>
                  {source && (
                    <div className={`${caption} truncate mt-0.5`}>
                      {source.repoLabel} · {source.remotePath} · {source.gitRef}
                    </div>
                  )}
                  {source && pullErrors[source.id] && (
                    <p className={`${caption} ${textDanger} mt-0.5`}>
                      {pullErrors[source.id].message}
                    </p>
                  )}
                </div>
                <OverflowMenu
                  title={t("catalogs.actions.menu")}
                  items={menuItems(catalog, status)}
                />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
