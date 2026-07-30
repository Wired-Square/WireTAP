// ui/src/apps/catalog/dialogs/PublishCatalogDialog.tsx
//
// Push a catalogue to a repository. Branch and pull request are both optional.
//
// The default is a direct commit to the branch the catalogue was pulled from — most
// pushes are a decoder going back to a repository the user owns, where a branch and a
// PR are ceremony around a one-file change. Both live under Advanced.
//
// Preflight runs automatically whenever the target changes and computes what pushing
// *would* do — validation, secret scan, whether a fork is needed, whether the target
// is public — with nothing written. It deliberately does *not* re-run when the branch
// or pull-request controls move: the plan is a function of the repository, not of the
// checkboxes, so re-planning per click would be a network round trip for no new
// information. The backend then streams step-by-step progress, because a fork poll can
// take tens of seconds.
//
// Publishing sends the file as saved on disk, never the editor buffer, so the toolbar
// disables this while there are unsaved changes.

import { useEffect, useRef, useState, type ComponentType } from "react";
import { useTranslation } from "react-i18next";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  AlertTriangle,
  CheckCircle2,
  ExternalLink,
  GitPullRequestArrow,
  Globe,
  Loader2,
  Lock,
  Radio,
  ShieldAlert,
  UploadCloud,
  XCircle,
} from "lucide-react";
import Dialog from "../../../components/Dialog";
import {
  FormField,
  Input,
  PrimaryButton,
  SecondaryButton,
  Select,
  Textarea,
} from "../../../components/forms";
import { iconMd, iconSm } from "../../../styles/spacing";
import {
  bgSurface,
  borderDivider,
  caption,
  cardCompact,
  h2,
  textDanger,
  textMedium,
  textSecondary,
  textSuccess,
  textWarning,
} from "../../../styles";
import { alertDanger, alertWarning, panelFooter } from "../../../styles/cardStyles";
import { badgeMetadata } from "../../../styles/badgeStyles";
import {
  PUBLISH_PROGRESS_EVENT,
  savedRepoName,
  type PublishPlan,
  type PublishProgress,
  type PublishRequest,
  type PublishStep,
  type SecretFinding,
} from "../../../api/catalogShare";
import { useCatalogShareStore } from "../../../stores/catalogShareStore";

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

/**
 * Sentinel for the dropdown's "add by URL" row. Not a valid repo id — ids are
 * `gh:owner/repo` — so it cannot collide with a real entry.
 */
const ADD_REPO_OPTION = "__add__";

/** Steps in the order the backend runs them. Some are skipped per publish. */
/**
 * The steps a given push will actually run. Rendering the full six would leave
 * `fork`, `branch` and `pr` permanently un-ticked on the default direct push, which
 * reads as a stall rather than as "not applicable".
 */
function stepsFor({
  forkNeeded,
  creatingBranch,
  openPr,
}: {
  forkNeeded: boolean;
  creatingBranch: boolean;
  openPr: boolean;
}): PublishStep[] {
  return [
    "validate",
    "auth",
    ...(forkNeeded ? (["fork"] as const) : []),
    ...(creatingBranch ? (["branch"] as const) : []),
    "commit",
    ...(openPr ? (["pr"] as const) : []),
  ];
}


type T = ReturnType<typeof useTranslation>["t"];

function PlanSummary({ plan, t }: { plan: PublishPlan; t: T }) {
  return (
    <div className={`${cardCompact} space-y-2`}>
      <div className="flex items-center gap-2 flex-wrap">
        <span className={textMedium}>{plan.upstream}</span>
        <span className={badgeMetadata}>{plan.baseBranch}</span>
        <span className={badgeMetadata}>
          {plan.targetIsPublic ? <Globe className={iconSm} /> : <Lock className={iconSm} />}
          {plan.targetIsPublic ? t("publish.public") : t("publish.private")}
        </span>
        <span className={badgeMetadata}>
          {plan.forkNeeded ? t("publish.viaFork") : t("publish.directPush")}
        </span>
      </div>
      <p className={caption}>
        {t("publish.willCommit", { path: plan.targetPath, bytes: plan.contentBytes })}
      </p>
      {plan.transmitFrameCount > 0 && (
        <p className={caption}>
          <Radio className={`${iconSm} inline`} />{" "}
          {t("publish.transmitFrames", { count: plan.transmitFrameCount })}
        </p>
      )}
      {plan.existingPrUrl && (
        <button
          onClick={() => void openUrl(plan.existingPrUrl!)}
          className={`${caption} underline hover:no-underline`}
        >
          {t("publish.existingPr")}
        </button>
      )}
    </div>
  );
}

function SecretFindings({
  findings,
  acknowledged,
  onAcknowledge,
  t,
}: {
  findings: SecretFinding[];
  acknowledged: boolean;
  onAcknowledge: () => void;
  t: T;
}) {
  return (
    <div className={`${alertDanger} space-y-2`}>
      <div className="flex items-start gap-2">
        <ShieldAlert className={`${iconMd} ${textDanger} flex-shrink-0 mt-0.5`} />
        <div>
          <p className={textMedium}>{t("publish.secretsFound", { count: findings.length })}</p>
          <p className={caption}>{t("publish.secretsAdvice")}</p>
        </div>
      </div>
      <ul className="space-y-0.5">
        {findings.map((f) => (
          <li key={`${f.line}-${f.label}`} className={caption}>
            {t("publish.secretLine", { line: f.line, label: f.label })}: <code>{f.excerpt}</code>
          </li>
        ))}
      </ul>
      <label className="flex items-center gap-2 cursor-pointer">
        <input type="checkbox" checked={acknowledged} onChange={onAcknowledge} />
        <span className={caption}>{t("publish.secretsAcknowledge")}</span>
      </label>
    </div>
  );
}

/** The alert shape this dialog repeats for exposure, fork, validation and secrets. */
function PlanAlert({
  tone,
  icon: Icon,
  children,
}: {
  tone: "warning" | "danger";
  icon: ComponentType<{ className?: string }>;
  children: React.ReactNode;
}) {
  const box = tone === "danger" ? alertDanger : alertWarning;
  const colour = tone === "danger" ? textDanger : textWarning;
  return (
    <div className={`${box} flex items-start gap-2`}>
      <Icon className={`${iconMd} ${colour} flex-shrink-0 mt-0.5`} />
      <div>{children}</div>
    </div>
  );
}

function StepChecklist({
  steps,
  expected,
  currentStep,
  detail,
  t,
}: {
  steps: PublishStep[];
  expected: PublishStep[];
  currentStep: PublishStep | null;
  detail: string | null;
  t: T;
}) {
  // Emitted steps are not a prefix of STEP_ORDER — `fork` only happens without push
  // access, `branch` only when one is named, `pr` only when asked for — so completion
  // is read from what actually arrived rather than inferred from position.
  const seen = new Set(steps);
  return (
    <div className={`${cardCompact} space-y-1`}>
      {expected.map((step) => {
        const active = currentStep === step;
        const done = seen.has(step) && !active;
        return (
          <div key={step} className="flex items-center gap-2">
            {done ? (
              <CheckCircle2 className={`${iconSm} ${textSuccess}`} />
            ) : active ? (
              <Loader2 className={`${iconSm} ${textSecondary} animate-spin`} />
            ) : (
              <div className={`${iconSm} rounded-full border border-current opacity-30`} />
            )}
            <span className={caption}>{t(`publish.step.${step}`)}</span>
            {active && detail && <span className={caption}>— {detail}</span>}
          </div>
        );
      })}
    </div>
  );
}

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
  const savedRepos = useCatalogShareStore((s) => s.savedRepos);
  const favouriteRepoId = useCatalogShareStore((s) => s.favouriteRepoId);
  const saveRepo = useCatalogShareStore((s) => s.saveRepo);
  const reposError = useCatalogShareStore((s) => s.reposError);
  const planPublish = useCatalogShareStore((s) => s.planPublish);
  const runPublish = useCatalogShareStore((s) => s.runPublish);
  const clearPublish = useCatalogShareStore((s) => s.clearPublish);
  const acknowledgeSecrets = useCatalogShareStore((s) => s.acknowledgeSecrets);
  const notePublishProgress = useCatalogShareStore((s) => s.notePublishProgress);
  const loadSources = useCatalogShareStore((s) => s.loadSources);

  // The selection, by id. Null until the user picks one, so the starred repository
  // is the default without an effect keeping the two in sync.
  const [pickedRepoId, setPickedRepoId] = useState<string | null>(null);
  // Inline "add a repository by URL" — revealed from the dropdown's last option.
  const [addingUrl, setAddingUrl] = useState<string | null>(null);
  const [commitMessage, setCommitMessage] = useState(
    filename ? t("publish.defaultMessage", { filename }) : "",
  );
  const [prTitle, setPrTitle] = useState("");
  const [prBody, setPrBody] = useState("");
  const [branch, setBranch] = useState("");
  const [targetPath, setTargetPath] = useState("");
  const [openPr, setOpenPr] = useState(false);
  const [draft, setDraft] = useState(false);
  // A fresh id per attempt so a stale event from a previous run is ignored. A ref, not
  // state: it is never rendered, and as state it would re-subscribe the listener
  // mid-flow, leaving a window with nothing attached.
  const requestId = useRef("");

  const plan = publishState.plan;

  // Mounted only while open, so this runs once per opening. `loadSources` supplies the
  // saved repositories; the token flag comes with it, so no separate identity call.
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

  const repoId = pickedRepoId ?? favouriteRepoId;
  const selectedRepo = savedRepos.find((r) => r.id === repoId) ?? null;

  const buildRequest = (id: string): PublishRequest => ({
    filename: filename ?? "",
    repoUrl: selectedRepo?.url ?? "",
    commitMessage: commitMessage.trim(),
    prTitle: prTitle.trim(),
    prBody: prBody.trim(),
    // Empty means "the base branch" — the ref this catalogue was pulled from,
    // which the backend resolves. Deliberately not prefilled from the plan: doing
    // so would turn the default direct push into an explicit `branch: "main"`.
    branch: branch.trim() || undefined,
    // The saved repository's directory is applied by the backend, *below* the
    // catalogue's own provenance path — a catalogue imported from `decoders/`
    // must publish back there, not into the saved directory.
    targetPath: targetPath.trim() || undefined,
    openPr,
    draft,
    requestId: id,
  });

  const handleAddRepo = async (url: string) => {
    const saved = await saveRepo(url.trim());
    if (saved) {
      setPickedRepoId(saved.id);
      setAddingUrl(null);
    }
  };

  // Preflight runs on its own whenever the target changes: it is two API requests,
  // and making the user press a button before they could see what would happen was
  // a step that only ever had one sensible answer. Only the *target* is a dependency
  // — the branch and pull-request toggles deliberately do not re-plan, because the
  // plan is a function of the repository, not of the checkboxes.
  useEffect(() => {
    if (!filename || !selectedRepo || !hasToken) return;
    requestId.current = `pub-${Date.now()}`;
    void planPublish(buildRequest(requestId.current)).then((next) => {
      if (next && !targetPath) setTargetPath(next.targetPath);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filename, selectedRepo?.id, hasToken]);

  const handlePublish = async () => {
    const result = await runPublish(buildRequest(requestId.current));
    if (result?.prUrl) await openUrl(result.prUrl);
  };

  // What the push will actually do, computed locally. The plan deliberately carries
  // no `willOpenPr`, so flipping a checkbox never needs a network round trip.
  const effectiveBranch = branch.trim() || (openPr ? plan?.suggestedBranch ?? "" : plan?.baseBranch ?? "");

  // Checked here rather than read off the plan: the conflict depends on the pull
  // request toggle, and the plan is deliberately not re-fetched when a checkbox moves.
  // The backend enforces the same rule — this only moves the message earlier.
  const prNeedsItsOwnBranch = openPr && !!plan && effectiveBranch === plan.baseBranch;
  const blockedByValidation =
    (plan?.validationErrors.length ?? 0) > 0 || prNeedsItsOwnBranch;
  const blockedBySecrets =
    (plan?.secretFindings.length ?? 0) > 0 && !publishState.secretsAcknowledged;
  const canPublish =
    !!plan && !blockedByValidation && !blockedBySecrets && !publishState.inFlight;
  const result = publishState.result;

  return (
    <Dialog isOpen={isOpen} onBackdropClick={onClose} maxWidth="max-w-2xl">
      <div className={`${bgSurface} rounded-xl shadow-xl overflow-hidden`}>
        <div className={`p-4 ${borderDivider}`}>
          <h2 className={h2}>{t("publish.title")}</h2>
          <p className={caption}>
            {filename ? t("publish.subtitle", { filename }) : t("publish.noCatalog")}
          </p>
        </div>

        <div className="p-4 space-y-3 max-h-[62vh] overflow-y-auto">
          {!hasToken && (
            <div className={`${alertWarning} flex items-start justify-between gap-2`}>
              <div className="flex items-start gap-2">
                <ShieldAlert className={`${iconMd} ${textWarning} flex-shrink-0 mt-0.5`} />
                <p className={caption}>{t("publish.needsAccount")}</p>
              </div>
              <SecondaryButton onClick={() => onNeedAccount?.()}>
                {t("publish.connect")}
              </SecondaryButton>
            </div>
          )}

          {/* Success state replaces the form — there is nothing left to edit. */}
          {result ? (
            <div className={`${cardCompact} space-y-2`}>
              <div className="flex items-center gap-2">
                <CheckCircle2 className={`${iconMd} ${textSuccess}`} />
                <span className={textMedium}>{t(`publish.action.${result.action}`)}</span>
              </div>
              <p className={caption}>
                {result.headOwner} · {result.branch}
                {result.reusedBranch ? ` · ${t("publish.reusedBranch")}` : ""}
              </p>
              <div className="flex gap-2 pt-1">
                {result.prUrl && (
                  <SecondaryButton onClick={() => void openUrl(result.prUrl!)}>
                    <ExternalLink className={iconSm} />
                    {t("publish.openPr")}
                  </SecondaryButton>
                )}
                {result.commitUrl && (
                  <SecondaryButton onClick={() => void openUrl(result.commitUrl!)}>
                    <ExternalLink className={iconSm} />
                    {t("publish.openCommit")}
                  </SecondaryButton>
                )}
              </div>
            </div>
          ) : (
            <>
              <div className="flex gap-2 items-end">
                <div className="flex-1">
                  <FormField label={t("publish.repoLabel")}>
                    <Select
                      value={addingUrl === null ? (repoId ?? "") : ADD_REPO_OPTION}
                      onChange={(e) => {
                        if (e.target.value === ADD_REPO_OPTION) {
                          setAddingUrl("");
                        } else {
                          setAddingUrl(null);
                          setPickedRepoId(e.target.value || null);
                        }
                      }}
                    >
                      <option value="">{t("publish.repoPlaceholder")}</option>
                      {savedRepos.map((repo) => (
                        <option key={repo.id} value={repo.id}>
                          {savedRepoName(repo)}
                          {repo.id === favouriteRepoId ? " ★" : ""}
                        </option>
                      ))}
                      <option value={ADD_REPO_OPTION}>{t("publish.repoAddOption")}</option>
                    </Select>
                  </FormField>
                </div>
                <SecondaryButton onClick={() => onNeedRepo?.()}>
                  {t("publish.createRepo")}
                </SecondaryButton>
              </div>

              {addingUrl !== null && (
                <div className="flex gap-2 items-end">
                  <div className="flex-1">
                    <FormField label={t("publish.repoUrlLabel")}>
                      <Input
                        value={addingUrl}
                        onChange={(e) => setAddingUrl(e.target.value)}
                        placeholder="https://github.com/owner/repo"
                        autoFocus
                      />
                    </FormField>
                  </div>
                  <SecondaryButton onClick={() => setAddingUrl(null)}>
                    {t("publish.cancel")}
                  </SecondaryButton>
                  <PrimaryButton
                    onClick={() => void handleAddRepo(addingUrl)}
                    disabled={!addingUrl.trim()}
                  >
                    {t("publish.repoAdd")}
                  </PrimaryButton>
                </div>
              )}

              {reposError && (
                <p className={`${caption} ${textDanger}`}>{reposError.message}</p>
              )}

              {savedRepos.length === 0 && addingUrl === null && (
                <p className={caption}>{t("publish.repoNone")}</p>
              )}

              <FormField label={t("publish.messageLabel")}>
                <Input value={commitMessage} onChange={(e) => setCommitMessage(e.target.value)} />
              </FormField>

              {publishState.planning && (
                <p className={caption}>
                  <Loader2 className={`${iconSm} animate-spin inline mr-1`} />
                  {t("publish.checking")}
                </p>
              )}

              {/* Where this is going, in one line, before any of it happens. */}
              {plan && (
                <p className={caption}>
                  {t("publish.target", {
                    repo: plan.upstream,
                    branch: effectiveBranch,
                    path: targetPath.trim() || plan.targetPath,
                  })}
                </p>
              )}

              {plan?.forkNeeded && (
                <PlanAlert tone="warning" icon={GitPullRequestArrow}>
                  <p className={caption}>{t("publish.noPushAccess", { repo: plan.upstream })}</p>
                </PlanAlert>
              )}

              {plan && <PlanSummary plan={plan} t={t} />}

              {plan?.targetIsPublic && (
                <PlanAlert tone="warning" icon={Globe}>
                  <p className={caption}>{t("publish.publicWarning")}</p>
                </PlanAlert>
              )}

              {blockedByValidation && (
                <PlanAlert tone="danger" icon={XCircle}>
                  <p className={textMedium}>{t("publish.invalid")}</p>
                    <p className={caption}>
                      {prNeedsItsOwnBranch
                        ? t("publish.prNeedsBranch", { branch: plan?.baseBranch })
                      : plan?.validationErrors.join("; ")}
                  </p>
                </PlanAlert>
              )}

              {plan && plan.secretFindings.length > 0 && (
                <SecretFindings
                  findings={plan.secretFindings}
                  acknowledged={publishState.secretsAcknowledged}
                  onAcknowledge={acknowledgeSecrets}
                  t={t}
                />
              )}

              {plan && (
                <details className={cardCompact}>
                  <summary className={`${caption} cursor-pointer`}>
                    {t("publish.advanced")}
                  </summary>
                  <div className="space-y-3 pt-3">
                    <FormField label={t("publish.pathLabel")}>
                      <Input value={targetPath} onChange={(e) => setTargetPath(e.target.value)} />
                    </FormField>
                    {/* Placeholder, never prefilled: an empty field means "the base
                        branch", and filling it in would silently turn the default
                        direct push into an explicit branch name. */}
                    <FormField label={t("publish.branchLabel")}>
                      <Input
                        value={branch}
                        onChange={(e) => setBranch(e.target.value)}
                        placeholder={openPr ? plan.suggestedBranch : plan.baseBranch}
                      />
                    </FormField>
                    <p className={caption}>
                      {t("publish.branchHelp", { branch: plan.baseBranch })}
                    </p>
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={openPr}
                        onChange={(e) => setOpenPr(e.target.checked)}
                      />
                      <span className={caption}>{t("publish.openPrLabel")}</span>
                    </label>
                    {openPr && (
                      <>
                        <FormField label={t("publish.prTitleLabel")}>
                          <Input value={prTitle} onChange={(e) => setPrTitle(e.target.value)} />
                        </FormField>
                        <FormField label={t("publish.prBodyLabel")}>
                          <Textarea
                            value={prBody}
                            onChange={(e) => setPrBody(e.target.value)}
                            rows={4}
                          />
                        </FormField>
                        <label className="flex items-center gap-2 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={draft}
                            onChange={(e) => setDraft(e.target.checked)}
                          />
                          <span className={caption}>{t("publish.draft")}</span>
                        </label>
                      </>
                    )}
                  </div>
                </details>
              )}

              {(publishState.inFlight || publishState.steps.length > 0) && (
                <StepChecklist
                  steps={publishState.steps}
                  expected={stepsFor({
                    forkNeeded: !!plan?.forkNeeded,
                    creatingBranch: !!plan && effectiveBranch !== plan.baseBranch,
                    openPr,
                  })}
                  currentStep={publishState.currentStep}
                  detail={publishState.detail}
                  t={t}
                />
              )}

              {publishState.error && (
                <PlanAlert tone="danger" icon={AlertTriangle}>
                  <p className={caption}>{publishState.error.message}</p>
                  {publishState.error.kind === "network" && (
                    <p className={caption}>{t("publish.retryHint")}</p>
                  )}
                </PlanAlert>
              )}
            </>
          )}
        </div>

        <div className={`${panelFooter} flex justify-end gap-2`}>
          <SecondaryButton onClick={onClose}>
            {result ? t("publish.done") : t("publish.cancel")}
          </SecondaryButton>
          {!result && (
            <PrimaryButton onClick={() => void handlePublish()} disabled={!canPublish}>
              {publishState.inFlight ? (
                <Loader2 className={`${iconMd} animate-spin`} />
              ) : (
                <UploadCloud className={iconMd} />
              )}
              {openPr ? t("publish.pushAndPrAction") : t("publish.pushAction")}
            </PrimaryButton>
          )}
        </div>
      </div>
    </Dialog>
  );
}
