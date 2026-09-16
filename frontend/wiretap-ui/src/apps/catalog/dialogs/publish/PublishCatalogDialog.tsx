// ui/src/apps/catalog/dialogs/publish/PublishCatalogDialog.tsx
//
// Push a catalogue to a repository. Branch and pull request are both optional.
//
// The default is a direct commit to the branch the catalogue was pulled from — most
// pushes are a decoder going back to a repository the user owns, where a branch and a
// PR are ceremony around a one-file change. Both live on their own tab.
//
// Preflight runs automatically whenever the target changes and computes what pushing
// *would* do — validation, secret scan, whether a fork is needed, whether the target
// is public — with nothing written. It deliberately does *not* re-run when the branch
// or pull-request controls move: the plan is a function of the repository, not of the
// checkboxes, so re-planning per click would be a network round trip for no new
// information. The backend then streams step-by-step progress, because a fork poll can
// take tens of seconds.
//
// ## Why the chrome is where it is
//
// The repository, the message and the target line are pinned above the tabs: they are
// the identity of the push, not one tab's worth of it. The blocker strip, the progress
// checklist and the buttons are pinned below them, because a tab can now hide a control
// that disables Push — so the reason it is disabled has to sit beside the button rather
// than inside a panel you may have navigated away from.
//
// Publishing sends the file as saved on disk, never the editor buffer, so the toolbar
// disables this while there are unsaved changes.

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import * as ShareIcon from "../../../../components/catalogIcons";
import Dialog from "../../../../components/Dialog";
import TabStrip from "../../../../components/TabStrip";
import { FormField, Input, PrimaryButton, SecondaryButton } from "../../../../components/forms";
import { iconMd, iconSm } from "../../../../styles/spacing";
import {
  borderDivider,
  caption,
  cardCompact,
  h2,
  textMedium,
  textSecondary,
  textSuccess,
} from "../../../../styles";
import { panelFooter } from "../../../../styles/cardStyles";
import { badgeMetadataIcon } from "../../../../styles/badgeStyles";
import {
  PUBLISH_PROGRESS_EVENT,
  type PublishProgress,
  type PublishRequest,
  type PublishResult,
} from "../../../../api/catalogShare";
import { useCatalogShareStore } from "../../../../stores/catalogShareStore";
import { useCatalogEditorStore } from "../../../../stores/catalogEditorStore";
import { sourcesFor } from "../../../../hooks/useCatalogSources";
import { CatalogSyncBadge } from "../../../../components/catalogSyncPresentation";
import RepoPicker from "./RepoPicker";
import PushTab from "./PushTab";
import BranchTab from "./BranchTab";
import DiffTab from "./DiffTab";
import { BlockerStrip, PlanAlert, StepChecklist } from "./parts";
import { stepsFor } from "./publishSteps";
import { publishTabs } from "./publishTabs";
import { publishBlockers } from "./publishBlockers";
import { usePublishDiff } from "./usePublishDiff";
import { EMPTY_PUBLISH_FORM, type PublishForm, type PublishTab, type T } from "./types";

type Props = {
  isOpen: boolean;
  onClose: () => void;
  /** Filename within the decoder directory — the saved bytes are what get published. */
  filename: string | null;
  /** A repository just created in-app: it is saved and selected on mount. */
  initialRepoUrl?: string;
  onNeedAccount?: () => void;
  onNeedRepo?: () => void;
};

export default function PublishCatalogDialog({
  isOpen,
  onClose,
  filename,
  initialRepoUrl = "",
  onNeedAccount,
  onNeedRepo,
}: Props) {
  const { t } = useTranslation("catalog");

  const publishState = useCatalogShareStore((s) => s.publishState);
  const hasToken = useCatalogShareStore((s) => s.hasToken);
  const login = useCatalogShareStore((s) => s.login);
  const savedRepos = useCatalogShareStore((s) => s.savedRepos);
  const favouriteRepoId = useCatalogShareStore((s) => s.favouriteRepoId);
  const tracked = useCatalogShareStore((s) => s.tracked);
  const linkSource = useCatalogShareStore((s) => s.linkSource);
  const saveRepo = useCatalogShareStore((s) => s.saveRepo);
  const planPublish = useCatalogShareStore((s) => s.planPublish);
  const runPublish = useCatalogShareStore((s) => s.runPublish);
  const clearPublish = useCatalogShareStore((s) => s.clearPublish);
  const acknowledgeSecrets = useCatalogShareStore((s) => s.acknowledgeSecrets);
  const notePublishProgress = useCatalogShareStore((s) => s.notePublishProgress);
  const loadSources = useCatalogShareStore((s) => s.loadSources);

  // The selection, by id. Null until the user picks one, so the starred repository
  // is the default without an effect keeping the two in sync.
  const [pickedRepoId, setPickedRepoId] = useState<string | null>(null);
  const [commitMessage, setCommitMessage] = useState(
    filename ? t("publish.defaultMessage", { filename }) : "",
  );
  const [form, setForm] = useState<PublishForm>(EMPTY_PUBLISH_FORM);
  const [tab, setTab] = useState<PublishTab>("push");
  // Latched, not derived from `tab`: leaving and returning must not re-fetch, but a
  // branch or path edited while the tab is open must.
  const [diffOpened, setDiffOpened] = useState(false);
  // A fresh id per attempt so a stale event from a previous run is ignored. A ref, not
  // state: it is never rendered, and as state it would re-subscribe the listener
  // mid-flow, leaving a window with nothing attached.
  const requestId = useRef("");

  const setField = useCallback(
    <K extends keyof PublishForm>(key: K, value: PublishForm[K]) =>
      setForm((f) => ({ ...f, [key]: value })),
    [],
  );

  const plan = publishState.plan;

  // Mounted only while open, so this runs once per opening. `loadSources` supplies the
  // saved repositories; the token flag and login come with it, so no separate identity
  // call.
  useEffect(() => {
    clearPublish();
    void loadSources();
  }, [clearPublish, loadSources]);

  // A newly created repository arrives via props after mount. Save it so it is
  // selectable, and select it: creating a repository to publish to is a clear
  // enough signal that it belongs in the list.
  useEffect(() => {
    if (!initialRepoUrl) return;
    void saveRepo(initialRepoUrl).then((saved) => saved && setPickedRepoId(saved.id));
  }, [initialRepoUrl, saveRepo]);

  // Progress events are per-window modal UI, so they arrive as Tauri events rather
  // than WebSocket pushes. Listener lives in the component, per house convention.
  useEffect(() => {
    const unlisten = listen<PublishProgress>(PUBLISH_PROGRESS_EVENT, (event) => {
      if (event.payload.requestId !== requestId.current) return;
      notePublishProgress(event.payload.step, event.payload.detail);
    });
    return () => {
      void unlisten.then((off) => off());
    };
  }, [notePublishProgress]);

  // Every repository already holding this catalogue, and its status against each.
  const trackedHere = sourcesFor(tracked, filename);

  // The starred repository is the default, but a catalogue that lives in exactly one
  // repository defaults to that one instead: a push now leaves a permanent record —
  // a subscription, a repository entry and a clone — so defaulting to the star for a
  // decoder that plainly belongs somewhere else makes a wrong click expensive.
  const repoId =
    pickedRepoId ?? (trackedHere.length === 1 ? trackedHere[0].repoId : favouriteRepoId);
  const selectedRepo = savedRepos.find((r) => r.id === repoId) ?? null;
  const trackedInSelected = trackedHere.find((c) => c.repoId === repoId) ?? null;

  // Does the Catalog editor hold *this* catalogue with unsaved changes? Its own Push
  // button is already disabled while dirty, so this can only be true when publishing
  // from Settings → Catalogs — but that is exactly the case where a bump would be
  // written to disk and then silently reverted by the editor's next save.
  const editorIsDirty = useCatalogEditorStore(
    (s) => s.file.path?.split(/[/\\]/).pop() === filename && s.hasUnsavedChanges(),
  );
  const adoptOnDiskChange = useCatalogEditorStore((s) => s.adoptOnDiskChange);
  // Derived once, so the checkbox, the Changes tab's note and the request itself
  // cannot disagree about whether this push will bump.
  const willBump = form.bumpVersion && !editorIsDirty;

  const buildRequest = (id: string): PublishRequest => ({
    filename: filename ?? "",
    repoUrl: selectedRepo?.url ?? "",
    commitMessage: commitMessage.trim(),
    prTitle: form.prTitle.trim(),
    prBody: form.prBody.trim(),
    // Empty means "the base branch" — the ref this catalogue was pulled from,
    // which the backend resolves. Deliberately not prefilled from the plan: doing
    // so would turn the default direct push into an explicit `branch: "main"`.
    branch: form.branch.trim() || undefined,
    // The saved repository's directory is applied by the backend, *below* the
    // catalogue's own provenance path — a catalogue imported from `decoders/`
    // must publish back there, not into the saved directory.
    targetPath: form.targetPath.trim() || undefined,
    openPr: form.openPr,
    draft: form.draft,
    bumpVersion: willBump,
    requestId: id,
  });

  // Preflight runs on its own whenever the target changes: it is two API requests,
  // and making the user press a button before they could see what would happen was
  // a step that only ever had one sensible answer. Only the *target* is a dependency
  // — the branch and pull-request toggles deliberately do not re-plan, because the
  // plan is a function of the repository, not of the checkboxes.
  useEffect(() => {
    if (!filename || !selectedRepo || !hasToken) return;
    requestId.current = `pub-${Date.now()}`;
    void planPublish(buildRequest(requestId.current)).then((next) => {
      if (next) setForm((f) => (f.targetPath ? f : { ...f, targetPath: next.targetPath }));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filename, selectedRepo?.id, hasToken]);

  const handlePublish = async () => {
    const result = await runPublish(buildRequest(requestId.current));
    // The bump rewrote the file on disk. Nothing else tells the editor a file changed
    // underneath it, so a buffer left holding the old number would write it straight
    // back on the next save.
    if (result?.versionBump?.writtenLocally && filename) {
      await adoptOnDiskChange(filename);
    }
    if (result?.prUrl) await openUrl(result.prUrl);
  };

  const handleLink = async () => {
    if (!filename || !selectedRepo) return;
    const linked = await linkSource(
      filename,
      selectedRepo.url,
      effectivePath,
      plan?.baseBranch,
    );
    if (linked) onClose();
  };

  // What the push will actually do, computed locally and named once. The plan
  // deliberately carries no `willOpenPr`, so flipping a checkbox never needs a
  // network round trip.
  const effectiveBranch =
    form.branch.trim() ||
    (form.openPr ? plan?.suggestedBranch ?? "" : plan?.baseBranch ?? "");
  const effectivePath = form.targetPath.trim() || plan?.targetPath || "";

  const diffState = usePublishDiff({
    enabled: diffOpened,
    filename,
    repoUrl: selectedRepo?.url ?? null,
    targetPath: effectivePath,
    branch: effectiveBranch,
    baseBranch: plan?.baseBranch ?? "",
  });

  // Not memoised: this builds at most four small objects from values already in hand,
  // and nothing downstream is memoised, so a dependency array would cost more to
  // compare than the call costs to run.
  const blockers = publishBlockers({
    plan,
    openPr: form.openPr,
    effectiveBranch,
    effectivePath,
    secretsAcknowledged: publishState.secretsAcknowledged,
    diff: diffState.diff,
    t,
  });

  const openTab = (next: PublishTab) => {
    if (next === "diff") setDiffOpened(true);
    setTab(next);
  };

  // Nothing left to edit, so the tabs go too — leaving them up invites editing a form
  // that no longer applies to anything.
  if (publishState.result) {
    return (
      <Dialog isOpen={isOpen} onBackdropClick={onClose} maxWidth="max-w-4xl">
        <PublishSuccess result={publishState.result} filename={filename} onClose={onClose} t={t} />
      </Dialog>
    );
  }

  const canPublish = !!plan && blockers.length === 0 && !publishState.inFlight;
  // Adopting what is already upstream, rather than pushing to it. `baseBlobSha` is
  // exactly "the file exists on the base branch", which the plan always answers — the
  // Changes tab's `exists` is about the *chosen* branch, and a pull-request branch is
  // not what a subscription would record.
  const canLink = !!plan && !trackedInSelected && plan.baseBlobSha !== null;
  const tabs = publishTabs({ t, plan, blockers, diff: diffState });

  // Why Push is off, for the tooltip. The strip covers the blockers; these two are the
  // dialog's own states, which are not reasons the request is invalid.
  const disabledReason = !plan
    ? t("publish.tabsNeedRepo")
    : publishState.inFlight
      ? t("publish.checking")
      : blockers[0]?.message;

  return (
    <Dialog isOpen={isOpen} onBackdropClick={onClose} maxWidth="max-w-4xl">
      {/* No surface or shadow — Dialog owns both. This wrapper exists to clip the tab
          strip and the footer to the rounded corners, and to make the tab panel the
          only thing that scrolls. */}
      <div className="flex flex-col overflow-hidden rounded-xl">
        <div className={`px-4 pt-4 pb-3 space-y-3 ${borderDivider}`}>
          <PublishHeader
            t={t}
            filename={filename}
            login={hasToken ? login : null}
            planning={publishState.planning}
          />

          {!hasToken && (
            <PlanAlert
              tone="warning"
              action={
                <SecondaryButton onClick={() => onNeedAccount?.()}>
                  {t("publish.connect")}
                </SecondaryButton>
              }
            >
              <p className={caption}>{t("publish.needsAccount")}</p>
            </PlanAlert>
          )}

          <RepoPicker
            t={t}
            value={repoId}
            onPick={setPickedRepoId}
            onCreateRepo={() => onNeedRepo?.()}
            trackedHere={trackedHere}
          />

          {/* Where this catalogue stands against the chosen repository, in the one
              place markup is allowed — a native <option> holds text and nothing else.
              Worth saying plainly now that a push leaves a permanent record. */}
          {selectedRepo && (
            <div className="flex items-center gap-2 flex-wrap">
              {trackedInSelected ? (
                <>
                  <CatalogSyncBadge status={trackedInSelected.syncStatus} />
                  <span className={`${caption} truncate`}>
                    {trackedInSelected.remotePath} · {trackedInSelected.gitRef}
                  </span>
                </>
              ) : (
                <span className={caption}>
                  {canLink ? t("publish.notTrackedButPresent") : t("publish.notTrackedHere")}
                </span>
              )}
            </div>
          )}

          <FormField label={t("publish.messageLabel")}>
            <Input value={commitMessage} onChange={(e) => setCommitMessage(e.target.value)} />
          </FormField>

          {/* Where this is going, in one line, visible from every tab. */}
          {plan && (
            <p className={`${caption} ${textSecondary} font-mono truncate`}>
              {t("publish.target", {
                repo: plan.upstream,
                branch: effectiveBranch,
                path: effectivePath,
              })}
            </p>
          )}
        </div>

        <TabStrip tabs={tabs} activeTab={tab} onTabChange={openTab} />
        {/* Fixed height, so switching tabs never resizes the dialog. Each tab body
            owns its own scrolling — DiffView needs a bounded parent and must not sit
            inside a second scroller. */}
        <div className="h-[52vh] min-h-0 flex flex-col">
          {tab === "push" && (
            <PushTab
              t={t}
              plan={plan}
              secretsAcknowledged={publishState.secretsAcknowledged}
              onAcknowledgeSecrets={acknowledgeSecrets}
              bumpVersion={willBump}
              onBumpVersion={(checked) => setField("bumpVersion", checked)}
              editorIsDirty={editorIsDirty}
            />
          )}
          {tab === "branch" && plan && (
            <BranchTab
              t={t}
              plan={plan}
              form={form}
              onChange={setField}
              disabled={publishState.inFlight}
            />
          )}
          {tab === "diff" && (
            <DiffTab
              t={t}
              state={diffState}
              requestedBranch={form.branch}
              bumpVersion={willBump}
              metaVersion={plan?.metaVersion}
            />
          )}
        </div>

        {blockers.length > 0 && (
          <BlockerStrip blockers={blockers} activeTab={tab} onOpenTab={openTab} t={t} />
        )}

        {(publishState.inFlight || publishState.steps.length > 0) && (
          <div className="px-4 pb-2">
            <StepChecklist
              steps={publishState.steps}
              expected={stepsFor({
                forkNeeded: !!plan?.forkNeeded,
                creatingBranch: !!plan && effectiveBranch !== plan.baseBranch,
                openPr: form.openPr,
              })}
              currentStep={publishState.currentStep}
              detail={publishState.detail}
              t={t}
            />
          </div>
        )}

        {publishState.error && (
          <div className="px-4 pb-2">
            <PlanAlert tone="danger">
              <p className={caption}>{publishState.error.message}</p>
              {/* True of both actions here: publishing is idempotent, and linking
                  writes nothing until the fetch has succeeded. */}
              {publishState.error.kind === "network" && (
                <p className={caption}>{t("publish.retryHint")}</p>
              )}
            </PlanAlert>
          </div>
        )}

        <div className={`${panelFooter} flex justify-end gap-2`}>
          <SecondaryButton onClick={onClose}>{t("publish.cancel")}</SecondaryButton>
          {/* The way out of the one dead end here: bytes that already match upstream
              cannot be pushed, so without this there is no route to being tracked. */}
          {canLink && (
            <span title={t("publish.linkHint")}>
              <SecondaryButton
                onClick={() => void handleLink()}
                disabled={publishState.linking}
              >
                {publishState.linking ? (
                  <ShareIcon.Busy className={`${iconMd} animate-spin`} />
                ) : (
                  <ShareIcon.Link className={iconMd} />
                )}
                {t("publish.linkAction")}
              </SecondaryButton>
            </span>
          )}
          {/* Wrapped, because a disabled button does not fire hover events on every
              platform and the tooltip is the last "why is this off?" backstop. */}
          <span title={canPublish ? undefined : disabledReason}>
            <PrimaryButton onClick={() => void handlePublish()} disabled={!canPublish}>
              {publishState.inFlight ? (
                <ShareIcon.Busy className={`${iconMd} animate-spin`} />
              ) : (
                <ShareIcon.Push className={iconMd} />
              )}
              {form.openPr ? t("publish.pushAndPrAction") : t("publish.pushAction")}
            </PrimaryButton>
          </span>
        </div>
      </div>
    </Dialog>
  );
}

function PublishHeader({
  t,
  filename,
  login,
  planning,
}: {
  t: T;
  filename: string | null;
  /** Null when no account is connected. */
  login: string | null;
  planning: boolean;
}) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <h2 className={h2}>{t("publish.title")}</h2>
        <p className={caption}>
          {filename ? t("publish.subtitle", { filename }) : t("publish.noCatalog")}
        </p>
      </div>
      <div className="flex items-center gap-2 flex-shrink-0">
        {planning && (
          <span className={caption}>
            <ShareIcon.Busy className={`${iconSm} animate-spin inline mr-1`} />
            {t("publish.checking")}
          </span>
        )}
        {/* Which account this would push as. Pushing under the wrong identity is quiet
            and awkward to undo, so the answer is always on screen. */}
        {login && (
          <span className={badgeMetadataIcon} title={t("publish.connectedAs", { login })}>
            <ShareIcon.GitHub className={iconSm} />
            {login}
          </span>
        )}
      </div>
    </div>
  );
}

function PublishSuccess({
  result,
  filename,
  onClose,
  t,
}: {
  result: PublishResult;
  filename: string | null;
  onClose: () => void;
  t: T;
}) {
  return (
    <div className="flex flex-col overflow-hidden rounded-xl">
      <div className={`px-4 pt-4 pb-3 ${borderDivider}`}>
        <PublishHeader t={t} filename={filename} login={null} planning={false} />
      </div>
      <div className="p-4">
        <div className={`${cardCompact} space-y-2`}>
          <div className="flex items-center gap-2">
            <ShareIcon.Success className={`${iconMd} ${textSuccess}`} />
            <span className={textMedium}>{t(`publish.action.${result.action}`)}</span>
          </div>
          <p className={caption}>
            {result.headOwner} · {result.branch}
            {result.reusedBranch ? ` · ${t("publish.reusedBranch")}` : ""}
          </p>
          {result.versionBump && (
            <p className={caption}>
              {/* Two sentences, because the failed-guard case is not a footnote: the
                  bump is upstream but not on disk, so the catalogue now reads as
                  locally ahead and the user needs to know why. */}
              {t("publish.bumpedTo", { to: result.versionBump.to })}
              {!result.versionBump.writtenLocally && ` ${t("publish.bumpNotWritten")}`}
            </p>
          )}
          <div className="flex gap-2 pt-1">
            {result.prUrl && (
              <SecondaryButton onClick={() => void openUrl(result.prUrl!)}>
                <ShareIcon.PullRequest className={iconMd} />
                {t("publish.openPr")}
              </SecondaryButton>
            )}
            {result.commitUrl && (
              <SecondaryButton onClick={() => void openUrl(result.commitUrl!)}>
                <ShareIcon.GitHub className={iconMd} />
                {t("publish.openCommit")}
              </SecondaryButton>
            )}
          </div>
        </div>
      </div>
      <div className={`${panelFooter} flex justify-end gap-2`}>
        <SecondaryButton onClick={onClose}>{t("publish.done")}</SecondaryButton>
      </div>
    </div>
  );
}
