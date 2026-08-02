// ui/src/dialogs/catalog-share/RepositoryDialog.tsx
//
// The repositories catalogues are shared through, in two tabs:
//
//   Mine       — the user's own. One is starred as the default publish target.
//   Community  — other people's. Browse and import only, never a publish target.
//                Some ship with WireTAP and cannot be edited or removed.
//
// Only the list changes with the tab. The URL field, the candidate list and the
// Import footer below it are the browse-and-import workspace and are common to
// both — including Save, which adds to whichever list is on show.
//
// The listing comes from one recursive tree request (which carries a blob SHA per
// file), so names and validity are resolved by a second, per-file fetch. That split
// is why the list can appear immediately and fill in detail afterwards.

import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { useTranslation } from "react-i18next";
import { Copy, Lock, Search } from "lucide-react";
import * as ShareIcon from "../../components/catalogIcons";
import Alert from "../../components/Alert";
import Dialog from "../../components/Dialog";
import OverflowMenu, { type OverflowMenuItems } from "../../components/OverflowMenu";
import TabStrip, { type TabDef } from "../../components/TabStrip";
import { FormField, Input, PrimaryButton, SecondaryButton, Select } from "../../components/forms";
import { iconMd, iconSm } from "../../styles/spacing";
import {
  bgSurface,
  borderDivider,
  caption,
  cardCompact,
  emptyStateHint,
  emptyStateText,
  h2,
  hoverLight,
  textDanger,
  textMedium,
  textSecondary,
  textSuccess,
  textWarning,
} from "../../styles";
import { alertWarning, panelFooter } from "../../styles/cardStyles";
import { iconButtonHoverCompact, iconButtonHoverSmall } from "../../styles/buttonStyles";
import { badgeMetadata } from "../../styles/badgeStyles";
import { useCatalogShareStore } from "../../stores/catalogShareStore";
import { savedRepoName, revealRepoClone, GIT_PROGRESS_EVENT } from "../../api/catalogShare";
import type {
  CollisionPolicy,
  GitProgress,
  RemoteCatalog,
  RemoteEntry,
  SavedRepoView,
  ShareErrorKind,
} from "../../api/catalogShare";
import { writeClipboardText } from "../../api/clipboard";
import { useIsIOS } from "../../hooks/useIsIOS";

type Props = {
  isOpen: boolean;
  onClose: () => void;
  /** Called with the imported file's name so the editor can open it. */
  onImported?: (filename: string) => void;
};

type RepoTab = "mine" | "community";

/** A row from either list. `builtin` is set only on shipped community entries. */
type ListedRepo = SavedRepoView & { builtin?: boolean };

/**
 * Guidance per error kind — what the user can actually do about it. Keyed rather
 * than switched so the compiler checks the kind names.
 */
const HINT_KEYS: Partial<Record<ShareErrorKind, string>> = {
  auth: "repository.hints.auth",
  forbidden: "repository.hints.auth",
  rateLimited: "repository.hints.rateLimited",
  notFound: "repository.hints.notFound",
  network: "repository.hints.network",
};


function CandidateRow({
  entry,
  meta,
  checked,
  onToggle,
  t,
}: {
  entry: RemoteEntry;
  meta: RemoteCatalog | undefined;
  checked: boolean;
  onToggle: () => void;
  t: (key: string, opts?: Record<string, unknown>) => string;
}) {
  // Unresolved entries stay selectable; only a confirmed failure is disabled.
  const disabled = meta?.valid === false;
  return (
    <label
      className={`flex items-start gap-3 px-3 py-2 ${hoverLight} ${
        disabled ? "opacity-60" : "cursor-pointer"
      }`}
    >
      <input
        type="checkbox"
        className="mt-1"
        checked={checked}
        disabled={disabled}
        onChange={onToggle}
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 flex-wrap">
          <span className={textMedium}>{meta?.name ?? entry.filename}</span>
          {meta?.protocol && <span className={badgeMetadata}>{meta.protocol}</span>}
          {meta?.valid && <ShareIcon.Success className={`${iconSm} ${textSuccess}`} />}
          {disabled && (
            <span className={`${caption} ${textDanger}`}>{t("repository.invalid")}</span>
          )}
          {entry.alreadyTracked && (
            <span className={badgeMetadata}>{t("repository.tracked")}</span>
          )}
          {entry.nameCollides && (
            <span className={badgeMetadata}>{t("repository.collides")}</span>
          )}
        </div>
        <div className={`${caption} truncate`}>{entry.path}</div>
        {meta?.valid && (
          <div className={caption}>
            {t("repository.frames", { count: meta.frameCount })}
            {meta.transmitFrameCount > 0 && (
              <span className={textWarning}>
                {" · "}
                <ShareIcon.TransmitRisk className={`${iconSm} inline`} />{" "}
                {t("repository.transmitFrames", { count: meta.transmitFrameCount })}
              </span>
            )}
          </div>
        )}
        {disabled && meta.errors.length > 0 && (
          <div className={`${caption} ${textDanger}`}>{meta.errors.slice(0, 2).join("; ")}</div>
        )}
      </div>
    </label>
  );
}

/**
 * One repository: browse it, and reach the rest through the menu.
 *
 * The star and Remove render only where they mean something, which is what tells
 * the three kinds of row apart without the row knowing which list it is in — a
 * shipped community repository is simply the one given neither.
 */
function RepoRow({
  repo,
  isFavourite,
  showReveal,
  onBrowse,
  onToggleFavourite,
  onProperties,
  onRemove,
}: {
  repo: ListedRepo;
  isFavourite?: boolean;
  showReveal: boolean;
  onBrowse: () => void;
  /** Omitted where the repository cannot be a publish target. */
  onToggleFavourite?: () => void;
  onProperties: () => void;
  /** Omitted where the entry is not the user's to remove. */
  onRemove?: () => void;
}) {
  const { t } = useTranslation("catalog");

  const items: OverflowMenuItems = [
    !!onToggleFavourite && {
      label: t(isFavourite ? "repository.saved.unfavourite" : "repository.saved.favourite"),
      icon: ShareIcon.Favourite,
      onClick: onToggleFavourite,
    },
    // No file manager to reveal into on iOS.
    showReveal && {
      label: t("repository.saved.revealClone"),
      icon: ShareIcon.RevealClone,
      disabled: !repo.cloned,
      hint: repo.cloned ? undefined : t("repository.saved.revealCloneHint"),
      onClick: () => void revealRepoClone(repo.id),
    },
    { label: t("repository.saved.properties"), icon: ShareIcon.Properties, onClick: onProperties },
    !!onRemove && { separator: true },
    !!onRemove && {
      label: t("repository.saved.remove"),
      icon: ShareIcon.Delete,
      danger: true,
      onClick: onRemove,
    },
  ];

  return (
    <div className={`${cardCompact} flex items-center gap-2`}>
      {onToggleFavourite && (
        <button
          onClick={onToggleFavourite}
          className={`${iconButtonHoverCompact} flex-shrink-0`}
          title={t(isFavourite ? "repository.saved.unfavourite" : "repository.saved.favourite")}
        >
          <ShareIcon.Favourite
            className={`${iconMd} ${isFavourite ? "fill-yellow-500 text-yellow-500" : `${textSecondary} opacity-60`}`}
          />
        </button>
      )}

      <button onClick={onBrowse} className="flex-1 min-w-0 text-left" title={t("repository.saved.browse")}>
        <p className={`${textMedium} truncate`}>{savedRepoName(repo)}</p>
        <div className="flex items-center gap-1 flex-wrap">
          <span className={caption}>
            {repo.owner}/{repo.repo}
          </span>
          {repo.gitRef && <span className={badgeMetadata}>{repo.gitRef}</span>}
          {repo.directory && <span className={badgeMetadata}>{repo.directory}</span>}
          {isFavourite && (
            <span className={caption}>· {t("repository.saved.isFavourite")}</span>
          )}
          {repo.builtin && (
            <span className={caption}>· {t("repository.community.builtin")}</span>
          )}
        </div>
      </button>

      <OverflowMenu
        title={t("repository.saved.menu")}
        items={items}
        className="flex-shrink-0"
      />
    </div>
  );
}

/** One read-only fact, optionally copyable. */
function PropertyRow({
  label,
  value,
  mono,
  copy,
}: {
  label: string;
  value: string;
  mono?: boolean;
  copy?: boolean;
}) {
  const { t } = useTranslation("catalog");

  return (
    <div className="flex items-start gap-2">
      <span className={`${caption} w-24 flex-shrink-0 pt-0.5`}>{label}</span>
      <span
        className={`${caption} flex-1 min-w-0 break-all select-text ${mono ? "font-mono" : ""}`}
      >
        {value}
      </span>
      {copy && (
        <button
          onClick={() => void writeClipboardText(value)}
          className={`${iconButtonHoverSmall} flex-shrink-0`}
          title={t("repository.saved.copy")}
        >
          <Copy className={iconSm} />
        </button>
      )}
    </div>
  );
}

/**
 * A repository's details: what it is and where its clone lives, over the editable
 * display name, ref and directory.
 *
 * Saving re-runs the same command as an initial save, so the backend keeps one
 * definition of what an entry looks like. Without `onSave` the panel is read-only,
 * which is how a repository that ships with WireTAP shows its facts without
 * offering edits the backend would refuse.
 */
function RepoPropertiesDialog({
  repo,
  onClose,
  onSave,
}: {
  repo: ListedRepo;
  onClose: () => void;
  /** Resolves false when the backend refused, which keeps the dialog open. */
  onSave?: (fields: { label: string; gitRef: string; directory: string }) => Promise<boolean>;
}) {
  const { t, i18n } = useTranslation("catalog");
  const [label, setLabel] = useState(repo.label ?? "");
  const [gitRef, setGitRef] = useState(repo.gitRef ?? "");
  const [directory, setDirectory] = useState(repo.directory ?? "");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  return (
    <Dialog isOpen onBackdropClick={onClose} maxWidth="max-w-md">
      <div className={`${bgSurface} rounded-xl shadow-xl overflow-hidden`}>
        <div className={`p-4 ${borderDivider}`}>
          <h2 className={h2}>{t("repository.saved.propertiesTitle")}</h2>
          <p className={caption}>{savedRepoName(repo)}</p>
        </div>

        <div className={`p-4 space-y-2 ${borderDivider}`}>
          <PropertyRow
            label={t("repository.saved.repositoryLabel")}
            value={`${repo.owner}/${repo.repo}`}
          />
          <PropertyRow label={t("repository.saved.urlLabel")} value={repo.url} copy />
          {repo.savedAt && (
            <PropertyRow
              label={t("repository.saved.savedLabel")}
              value={new Date(repo.savedAt).toLocaleString(i18n.language)}
            />
          )}
          {/* The path shows either way — unfetched, it is where the clone will go. */}
          <PropertyRow
            label={t("repository.saved.clonePathLabel")}
            value={repo.clonePath}
            mono
            copy
          />
          {!repo.cloned && (
            <p className={`${caption} ${textWarning}`}>{t("repository.saved.notCloned")}</p>
          )}
        </div>

        {onSave && (
          <div className="p-4 space-y-3">
            <FormField label={t("repository.saved.labelLabel")}>
              <Input
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder={t("repository.saved.labelPlaceholder", {
                  owner: repo.owner,
                  repo: repo.repo,
                })}
              />
            </FormField>
            <FormField label={t("repository.saved.branchLabel")}>
              <Input
                value={gitRef}
                onChange={(e) => setGitRef(e.target.value)}
                placeholder={t("repository.saved.branchPlaceholder")}
              />
            </FormField>
            <FormField label={t("repository.saved.directoryLabel")}>
              <Input
                value={directory}
                onChange={(e) => setDirectory(e.target.value)}
                placeholder={t("repository.saved.directoryPlaceholder")}
              />
            </FormField>
            <p className={caption}>{t("repository.saved.editHint")}</p>
          </div>
        )}
        {/* A rejected directory would otherwise close the dialog and lose the edits,
            leaving the reason as small red text in the list behind it. */}
        {saveError && <p className={`${caption} ${textDanger} px-4`}>{saveError}</p>}
        <div className={`${panelFooter} flex justify-end gap-2`}>
          <SecondaryButton onClick={onClose}>
            {onSave ? t("repository.cancel") : t("repository.close")}
          </SecondaryButton>
          {onSave && (
            <PrimaryButton
              disabled={saving}
              onClick={() => {
                setSaving(true);
                setSaveError(null);
                void onSave({ label, gitRef, directory }).then((ok) => {
                  setSaving(false);
                  if (!ok) setSaveError(t("repository.saved.saveFailed"));
                });
              }}
            >
              {t("repository.saved.apply")}
            </PrimaryButton>
          )}
        </div>
      </div>
    </Dialog>
  );
}

export default function RepositoryDialog({ isOpen, onClose, onImported }: Props) {
  const { t } = useTranslation("catalog");

  // Per-field selectors: a bare useCatalogShareStore() would re-render this dialog
  // on every unrelated store write, including each keystroke's sibling state.
  const browse = useCatalogShareStore((s) => s.browse);
  const selection = useCatalogShareStore((s) => s.selection);
  const onCollision = useCatalogShareStore((s) => s.onCollision);
  const importState = useCatalogShareStore((s) => s.importState);
  const savedRepos = useCatalogShareStore((s) => s.savedRepos);
  const favouriteRepoId = useCatalogShareStore((s) => s.favouriteRepoId);
  const communityRepos = useCatalogShareStore((s) => s.communityRepos);
  const saveRepo = useCatalogShareStore((s) => s.saveRepo);
  const forgetRepo = useCatalogShareStore((s) => s.forgetRepo);
  const saveCommunityRepo = useCatalogShareStore((s) => s.saveCommunityRepo);
  const forgetCommunityRepo = useCatalogShareStore((s) => s.forgetCommunityRepo);
  const reposError = useCatalogShareStore((s) => s.reposError);
  const sourcesLoading = useCatalogShareStore((s) => s.sourcesLoading);
  const setFavouriteRepo = useCatalogShareStore((s) => s.setFavouriteRepo);
  const setUrl = useCatalogShareStore((s) => s.setUrl);
  const validateUrl = useCatalogShareStore((s) => s.validateUrl);
  const runBrowse = useCatalogShareStore((s) => s.runBrowse);
  const clearBrowse = useCatalogShareStore((s) => s.clearBrowse);
  const toggleSelection = useCatalogShareStore((s) => s.toggleSelection);
  const selectAllValid = useCatalogShareStore((s) => s.selectAllValid);
  const setCollisionPolicy = useCatalogShareStore((s) => s.setCollisionPolicy);
  const runImport = useCatalogShareStore((s) => s.runImport);
  const loadSources = useCatalogShareStore((s) => s.loadSources);

  // Null until the user picks one; the tab shown is derived until then, so an
  // in-flight load cannot land after a click and move it out from under them.
  const [picked, setPicked] = useState<RepoTab | null>(null);
  // Held by id, not by value: the record is re-read from the list on every render
  // so the properties panel cannot show facts a save or browse has moved on from.
  const [properties, setProperties] = useState<string | null>(null);
  // The first browse of a repository clones it, which is far slower than the tree
  // listing this replaced. Without this the dialog just sits there.
  const [gitProgress, setGitProgress] = useState<GitProgress | null>(null);
  // Resolved here rather than taken as a prop: the dialog is mounted from Settings
  // and from the catalogue picker, and only one of them knows the platform.
  const showReveal = !useIsIOS();

  useEffect(() => {
    const unlisten = listen<GitProgress>(GIT_PROGRESS_EVENT, (event) =>
      setGitProgress(event.payload),
    );
    return () => {
      void unlisten.then((off) => off());
    };
  }, []);

  // Only meaningful while something is in flight; a finished clone leaves its last
  // counts behind and they would otherwise linger.
  useEffect(() => {
    if (!browse.loading) setGitProgress(null);
  }, [browse.loading]);

  // Reset on open so a previous session's results don't linger, and load the
  // lists so they are there before the first render settles.
  useEffect(() => {
    if (!isOpen) {
      setPicked(null);
      return;
    }
    clearBrowse();
    void loadSources();
  }, [isOpen, clearBrowse, loadSources]);

  // Mine, falling back to Community when the user has nothing of their own — the
  // list that always has something. Waiting on the load matters: an empty saved
  // list means "not loaded yet" just as often as it means "none saved".
  const mine = picked ? picked === "mine" : sourcesLoading || savedRepos.length > 0;

  const repos: ListedRepo[] = mine ? savedRepos : communityRepos;
  // Which list Save and Remove act on follows the tab, so no call site below has
  // to ask again.
  const saveActive = mine ? saveRepo : saveCommunityRepo;
  const forgetActive = mine ? forgetRepo : forgetCommunityRepo;

  const propertiesRepo = repos.find((r) => r.id === properties);
  const entries = browse.result?.entries ?? [];
  const selectableCount = entries.filter((e) => browse.resolved[e.path]?.valid).length;
  const anyCollisions = entries.some((e) => e.nameCollides);
  const totalTransmitFrames = selection.reduce(
    (sum, path) => sum + (browse.resolved[path]?.transmitFrameCount ?? 0),
    0,
  );
  const hintKey = browse.error && HINT_KEYS[browse.error.kind];

  // Saving is only meaningful once the URL parses — the backend would reject it
  // anyway, and an enabled button that always errors is worse than a disabled one.
  const parsed = browse.parseError ? null : browse.parsed;
  // `repoId` is the backend's own identity key, so "already saved" cannot drift
  // from what a save would actually collide with. Checked against the list on
  // show, since that is the one Save would add to.
  const alreadySaved = !!parsed && repos.some((r) => r.id === parsed.repoId);

  const handleBrowseRepo = async (repo: ListedRepo) => {
    // Ref and directory go as arguments, not folded into a `/tree/…` URL: that
    // grammar cannot express "default branch, but this directory", and re-parsing
    // one would cost an extra request to disambiguate a split we already know.
    setUrl(repo.url);
    await runBrowse({ gitRef: repo.gitRef, directory: repo.directory });
    // The first browse of a repository clones it, so the row's clone state has
    // just changed and the list is what carries it.
    void loadSources();
  };

  const tabs: TabDef<RepoTab>[] = [
    { id: "mine", label: t("repository.tabs.mine"), badge: savedRepos.length },
    { id: "community", label: t("repository.tabs.community"), badge: communityRepos.length },
  ];

  const handleImport = async () => {
    const results = await runImport();
    const written = results.find(
      (r) => (r.outcome === "imported" || r.outcome === "updated") && r.filename,
    );
    if (written?.filename) onImported?.(written.filename);
  };

  return (
    <Dialog isOpen={isOpen} onBackdropClick={onClose} maxWidth="max-w-2xl">
      <div className={`${bgSurface} rounded-xl shadow-xl overflow-hidden`}>
        <div className={`p-4 ${borderDivider}`}>
          <h2 className={h2}>{t("repository.title")}</h2>
          <p className={caption}>{t("repository.subtitle")}</p>
        </div>

        <TabStrip tabs={tabs} activeTab={mine ? "mine" : "community"} onTabChange={setPicked} />

        <div className="p-4 space-y-3">
          <div className="space-y-2">
            <p className={caption}>
              {t(mine ? "repository.saved.hint" : "repository.community.hint")}
            </p>
            {reposError && (
              <p className={`${caption} ${textDanger}`}>{reposError.message}</p>
            )}
            {repos.length === 0 ? (
              <div className={`${cardCompact} text-center py-4`}>
                <p className={emptyStateText}>
                  {t(mine ? "repository.saved.empty" : "repository.community.empty")}
                </p>
                <p className={emptyStateHint}>{t("repository.saved.emptyHint")}</p>
              </div>
            ) : (
              <div className="space-y-1">
                {repos.map((repo) => (
                  <RepoRow
                    key={repo.id}
                    repo={repo}
                    showReveal={showReveal}
                    isFavourite={mine && repo.id === favouriteRepoId}
                    onBrowse={() => handleBrowseRepo(repo)}
                    // Only a repository of the user's own can be the publish
                    // default, and only their own entry is theirs to remove. The
                    // star is gated on the tab, not just the id: a repository in
                    // both lists would otherwise light up under Community too.
                    onToggleFavourite={
                      mine
                        ? () =>
                            void setFavouriteRepo(repo.id === favouriteRepoId ? null : repo.id)
                        : undefined
                    }
                    onProperties={() => setProperties(repo.id)}
                    onRemove={repo.builtin ? undefined : () => void forgetActive(repo.id)}
                  />
                ))}
              </div>
            )}
          </div>

          <div className="flex gap-2 items-start">
            <div className="flex-1">
              <Input
                value={browse.url}
                onChange={(e) => setUrl(e.target.value)}
                onBlur={() => void validateUrl()}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void runBrowse();
                }}
                placeholder={t("repository.urlPlaceholder")}
              />
              {browse.parseError && (
                <p className={`${caption} ${textDanger} mt-1`}>{browse.parseError}</p>
              )}
              {parsed && (
                <p className={`${caption} mt-1`}>
                  {parsed.owner}/{parsed.repo}
                  {parsed.reference ? ` @ ${parsed.reference}` : ""}
                  {parsed.path ? ` — ${parsed.path}` : ""}
                </p>
              )}
            </div>
            <SecondaryButton onClick={() => void runBrowse()} disabled={browse.loading}>
              {browse.loading ? (
                <ShareIcon.Busy className={`${iconMd} animate-spin`} />
              ) : (
                <Search className={iconMd} />
              )}
              {t("repository.browse")}
            </SecondaryButton>
            {/* Adds to the list on show — the only way into Community, whose rows
                are not otherwise the user's to change. */}
            <SecondaryButton
              onClick={() => void saveActive(browse.url.trim())}
              disabled={!parsed || alreadySaved}
            >
              <ShareIcon.SaveRepository className={iconMd} />
              {/* Worded per tab rather than tooltipped: which list this adds to is
                  the one thing that changes, so it belongs on the button's face. */}
              {mine
                ? t(alreadySaved ? "repository.saved.saved" : "repository.saved.save")
                : t(alreadySaved ? "repository.community.added" : "repository.community.add")}
            </SecondaryButton>
          </div>

          {browse.loading && gitProgress && (
            <p className={caption}>
              {t(`repository.git.${gitProgress.phase}`, {
                received: gitProgress.receivedObjects,
                total: gitProgress.totalObjects,
                kb: Math.round(gitProgress.receivedBytes / 1024),
              })}
            </p>
          )}

          {browse.error && (
            <Alert tone="danger">
              <p className={textMedium}>{browse.error.message}</p>
              {hintKey && <p className={caption}>{t(hintKey)}</p>}
            </Alert>
          )}

          {browse.result && (
            <div className={`${cardCompact} space-y-2`}>
              <div className="flex items-center gap-2 flex-wrap">
                <ShareIcon.Branch className={`${iconSm} ${textSecondary}`} />
                <span className={textMedium}>{browse.result.repo.fullName}</span>
                <span className={badgeMetadata}>{browse.result.gitRef}</span>
                {browse.result.repo.private && (
                  <span className={badgeMetadata}>
                    <Lock className={iconSm} />
                    {t("repository.private")}
                  </span>
                )}
                {!browse.result.authenticated && (
                  <span className={badgeMetadata}>{t("repository.anonymous")}</span>
                )}
              </div>
              <div className="flex items-start gap-2">
                <ShareIcon.Alert className={`${iconMd} ${textWarning} flex-shrink-0 mt-0.5`} />
                <p className={caption}>
                  {t("repository.unreviewedWarning", { repo: browse.result.repo.fullName })}
                </p>
              </div>
              {browse.result.dropped > 0 && (
                <p className={`${caption} ${textWarning}`}>
                  {t("repository.dropped", { count: browse.result.dropped })}
                </p>
              )}
            </div>
          )}

          {browse.result && (
            <div>
              <div className="flex items-center justify-between mb-1">
                <span className={caption}>
                  {t("repository.found", { count: entries.length })}
                  {browse.resolving ? ` · ${t("repository.resolving")}` : ""}
                </span>
                {selectableCount > 0 && (
                  <button
                    onClick={selectAllValid}
                    className={`${caption} underline hover:no-underline`}
                  >
                    {t("repository.selectAll", { count: selectableCount })}
                  </button>
                )}
              </div>

              <div className="max-h-[34vh] overflow-y-auto rounded-lg border border-[color:var(--border-default)]">
                {entries.length === 0 ? (
                  <p className={`p-4 ${caption}`}>{t("repository.noneFound")}</p>
                ) : (
                  entries.map((entry) => (
                    <CandidateRow
                      key={entry.path}
                      entry={entry}
                      meta={browse.resolved[entry.path]}
                      checked={selection.includes(entry.path)}
                      onToggle={() => toggleSelection(entry.path)}
                      t={t}
                    />
                  ))
                )}
              </div>
              {browse.resolveError && (
                <p className={`${caption} ${textWarning} mt-1`}>{browse.resolveError.message}</p>
              )}
            </div>
          )}

          {/* The one genuinely physical risk: an imported catalogue can define bus traffic. */}
          {totalTransmitFrames > 0 && (
            <div className={`${alertWarning} flex items-start gap-2`}>
              <ShareIcon.TransmitRisk className={`${iconMd} ${textWarning} flex-shrink-0 mt-0.5`} />
              <p className={caption}>
                {t("repository.transmitWarning", { count: totalTransmitFrames })}
              </p>
            </div>
          )}

          {anyCollisions && (
            <div>
              <label className={caption}>{t("repository.collisionLabel")}</label>
              <Select
                value={onCollision}
                onChange={(e) => setCollisionPolicy(e.target.value as CollisionPolicy)}
              >
                <option value="keepBoth">{t("repository.collision.keepBoth")}</option>
                <option value="skip">{t("repository.collision.skip")}</option>
                <option value="overwrite">{t("repository.collision.overwrite")}</option>
              </Select>
            </div>
          )}

          {importState.results && (
            <div className={`${cardCompact} space-y-1`}>
              {importState.results.map((r) => {
                const failed = r.outcome === "failed" || r.outcome === "skipped";
                return (
                  <div key={r.path} className="flex items-start gap-2">
                    {failed ? (
                      <ShareIcon.Alert
                        className={`${iconSm} ${textWarning} flex-shrink-0 mt-0.5`}
                      />
                    ) : (
                      <ShareIcon.Success
                        className={`${iconSm} ${textSuccess} flex-shrink-0 mt-0.5`}
                      />
                    )}
                    <div className="min-w-0">
                      <span className={textMedium}>{r.filename ?? r.path}</span>
                      <div className={caption}>
                        {t(`repository.outcome.${r.outcome}`)}
                        {r.message ? ` — ${r.message}` : ""}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {importState.error && (
            <p className={`${caption} ${textDanger}`}>{importState.error.message}</p>
          )}
        </div>

        <div className={`${panelFooter} flex justify-end gap-2`}>
          <SecondaryButton onClick={onClose}>
            {importState.results ? t("repository.done") : t("repository.cancel")}
          </SecondaryButton>
          <PrimaryButton
            onClick={() => void handleImport()}
            disabled={selection.length === 0 || importState.inFlight}
          >
            {importState.inFlight ? (
              <ShareIcon.Busy className={`${iconMd} animate-spin`} />
            ) : (
              <ShareIcon.ImportCatalog className={iconMd} />
            )}
            {t("repository.import", { count: selection.length })}
          </PrimaryButton>
        </div>
      </div>

      {propertiesRepo && (
        <RepoPropertiesDialog
          repo={propertiesRepo}
          onClose={() => setProperties(null)}
          // A shipped entry has nothing the backend would accept an edit to, so
          // its panel is read-only. `builtin` only ever reaches a community row,
          // so a repository saved to both lists stays editable under Mine.
          onSave={
            propertiesRepo.builtin
              ? undefined
              : async (fields) => {
                  // Re-save by URL: the backend owns what an entry looks like, and
                  // the id is derived from the URL, so this updates in place.
                  const saved = await saveActive(propertiesRepo.url, fields);
                  if (saved) setProperties(null);
                  return !!saved;
                }
          }
        />
      )}
    </Dialog>
  );
}
