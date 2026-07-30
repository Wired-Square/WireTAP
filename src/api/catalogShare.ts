// ui/src/api/catalogShare.ts
// Sharing catalogue decoders over git (GitHub REST).
//
// These are Tauri `invoke` commands rather than `catalog.*` WebSocket commands:
// the WS surface is deliberately pure (no filesystem, settings or keychain) and
// has a 10s timeout that network work would blow through. The app CSP also blocks
// direct calls to api.github.com from the webview, so all HTTP lives in Rust.

import { invoke } from "@tauri-apps/api/core";
import { revealItemInDir } from "@tauri-apps/plugin-opener";

/** What a shared URL pointed at within the repository. */
export type SourceKind = "repo" | "directory" | "file";

/** A parsed repository reference. Mirrors the Rust `CatalogSource`. */
export interface CatalogSource {
  host: string;
  owner: string;
  repo: string;
  /** Stable identity key, `gh:{owner}/{repo}`. The one definition of "same repo". */
  repoId: string;
  /** Branch, tag or sha. Null means "the repository default branch". */
  reference: string | null;
  /** Repo-relative directory or file path. */
  path: string | null;
  kind: SourceKind;
  /** The ref/path split could not be determined from the URL alone. */
  refIsAmbiguous?: boolean;
}

export type ShareErrorKind =
  | "auth"
  | "forbidden"
  | "rateLimited"
  | "notFound"
  | "network"
  | "api"
  | "unsupportedHost"
  | "invalid";

/** A typed backend failure. `kind` decides whether to offer Retry or route to settings. */
export interface ShareError {
  kind: ShareErrorKind;
  message: string;
  retryAfterSecs?: number;
}

/** Narrow an unknown catch value to a {@link ShareError}. */
export function asShareError(error: unknown): ShareError {
  if (
    error &&
    typeof error === "object" &&
    "kind" in error &&
    "message" in error &&
    typeof (error as ShareError).message === "string"
  ) {
    return error as ShareError;
  }
  return { kind: "invalid", message: String(error) };
}

export interface RepoInfo {
  owner: string;
  name: string;
  fullName: string;
  defaultBranch: string;
  private: boolean;
  fork: boolean;
  /** Whether the connected account can push — decides fork vs direct publishing. */
  canPush: boolean;
  allowForking: boolean;
  htmlUrl: string;
  description?: string;
  parentFullName?: string;
}

/** A candidate catalogue found in the repository tree, before content is fetched. */
export interface RemoteEntry {
  path: string;
  filename: string;
  blobSha: string;
  size: number;
  /** A local catalogue already carries this exact provenance. */
  alreadyTracked: boolean;
  /** A local file of the same name exists that we did not import. */
  nameCollides: boolean;
}

export interface RepoBrowse {
  source: CatalogSource;
  repo: RepoInfo;
  gitRef: string;
  entries: RemoteEntry[];
  /** Candidates beyond the display cap that were dropped. */
  dropped: number;
  authenticated: boolean;
}

/**
 * A repository the user has chosen to keep. Independent of whether any catalogue
 * currently comes from it — the backend's `repos` list is garbage-collected, this
 * one is not.
 */
export interface SavedRepo {
  /** Stable key, `gh:{owner}/{repo}`. */
  id: string;
  /** Canonical repository URL, fed straight to `PublishRequest.repoUrl`. */
  url: string;
  owner: string;
  repo: string;
  /** Display name; falls back to `{owner}/{repo}`. */
  label?: string;
  /** Ref to browse and import from. NOT the publish branch. */
  gitRef?: string;
  /** Repo-relative directory holding catalogues, e.g. `catalogs`. */
  directory?: string;
  savedAt: string;
}

/**
 * A saved repository as the backend lists it: the stored entry plus where its
 * clone is. Derived per call and never persisted, so it can only be read from a
 * listing — see `git::repos_root` on why a clone path must not be stored.
 */
export interface SavedRepoView extends SavedRepo {
  /** Absolute path the clone occupies, or would occupy once fetched. */
  clonePath: string;
  /** False until the repository has been browsed at least once. */
  cloned: boolean;
}

/**
 * The saved list after a mutation. Returned by every mutating command so callers
 * patch state instead of re-listing, which would hash every tracked catalogue.
 */
export interface SavedReposView {
  savedRepos: SavedRepoView[];
  favouriteRepoId?: string;
}

/** A newly saved repository, plus the refreshed list it belongs to. */
export interface SaveRepoResult extends SavedReposView {
  saved: SavedRepo;
}

/** What to show for a saved repository in a list or dropdown. */
export function savedRepoName(repo: SavedRepo): string {
  return repo.label?.trim() || `${repo.owner}/${repo.repo}`;
}

/** Resolved metadata for one remote catalogue (needs a content fetch). */
export interface RemoteCatalog {
  path: string;
  blobSha: string;
  name: string | null;
  valid: boolean;
  errors: string[];
  frameCount: number;
  /**
   * Frames declaring a transmit interval. Surfaced prominently: an imported
   * catalogue can define traffic that would be written to a live bus.
   */
  transmitFrameCount: number;
  protocol?: string;
}

export type CollisionPolicy = "keepBoth" | "skip" | "overwrite";

export interface ImportRequest {
  input: string;
  gitRef: string;
  paths: string[];
  onCollision?: CollisionPolicy;
}

export type ImportOutcome = "imported" | "updated" | "skipped" | "failed";

export interface ImportResult {
  path: string;
  outcome: ImportOutcome;
  filename?: string;
  name?: string;
  message?: string;
}

/** Local file versus the bytes last exchanged with the remote. No network needed. */
export type LocalState = "untracked" | "committed" | "modified" | "missing";

/** Remote versus what we last synced. Only meaningful after an update check. */
export type RemoteState = "unknown" | "inSync" | "upstreamAhead" | "diverged";

export interface TrackedCatalog {
  id: string;
  localFilename: string;
  repoId: string;
  repoLabel: string;
  remotePath: string;
  gitRef: string;
  localState: LocalState;
  remoteState: RemoteState;
  webUrl?: string;
  prUrl?: string;
  prNumber?: number;
  prMerged: boolean;
}

export interface CatalogSourcesView {
  catalogs: TrackedCatalog[];
  savedRepos: SavedRepoView[];
  favouriteRepoId?: string;
  hasToken: boolean;
  login?: string;
}

/**
 * Parse a shared URL without touching the network — for live feedback as the
 * user types or pastes.
 */
export async function parseCatalogSourceUrl(input: string): Promise<CatalogSource> {
  return await invoke<CatalogSource>("parse_catalog_source_url", { input });
}

/**
 * List candidate catalogues in a repository (two GitHub API requests).
 *
 * `gitRef`/`directory` narrow the scope when the caller knows them exactly (a
 * saved repository); identity still comes from re-parsing `input`.
 */
export async function browseCatalogRepo(
  input: string,
  scope: { gitRef?: string; directory?: string } = {},
): Promise<RepoBrowse> {
  return await invoke<RepoBrowse>("browse_catalog_repo", {
    input,
    gitRef: scope.gitRef ?? null,
    directory: scope.directory ?? null,
  });
}

/** Fetch and parse specific catalogues to get names, validity and frame counts. */
export async function resolveRemoteCatalogs(
  input: string,
  gitRef: string,
  paths: string[],
): Promise<RemoteCatalog[]> {
  return await invoke<RemoteCatalog[]>("resolve_remote_catalogs", { input, gitRef, paths });
}

/** Fetch the selected catalogues and write them into the decoder directory. */
export async function importRemoteCatalogs(req: ImportRequest): Promise<ImportResult[]> {
  return await invoke<ImportResult[]>("import_remote_catalogs", { req });
}

/** Provenance and sync state for every tracked catalogue. */
export async function listCatalogSources(): Promise<CatalogSourcesView> {
  return await invoke<CatalogSourcesView>("list_catalog_sources");
}

/** Stop tracking a catalogue. Does not delete the file. */
export async function forgetCatalogSource(catalogId: string): Promise<void> {
  await invoke("forget_catalog_source", { catalogId });
}

// ── Saved repositories ───────────────────────────────────────────────────────

/**
 * Save a repository for reuse. Anything left blank is inferred from the URL, so
 * pasting `.../tree/main/catalogs` captures the ref and directory too.
 */
export async function saveCatalogRepo(
  input: string,
  opts: { label?: string; gitRef?: string; directory?: string } = {},
): Promise<SaveRepoResult> {
  return await invoke<SaveRepoResult>("save_catalog_repo", {
    input,
    label: opts.label ?? null,
    gitRef: opts.gitRef ?? null,
    directory: opts.directory ?? null,
  });
}

/** Drop a saved repository. Catalogues imported from it keep their provenance. */
export async function forgetCatalogRepo(repoId: string): Promise<SavedReposView> {
  return await invoke<SavedReposView>("forget_catalog_repo", { repoId });
}

/** Star one saved repository as the default publish target, or `null` to clear. */
export async function setFavouriteCatalogRepo(repoId: string | null): Promise<SavedReposView> {
  return await invoke<SavedReposView>("set_favourite_catalog_repo", { repoId });
}

// ── Updates ──────────────────────────────────────────────────────────────────

export interface UpdateCheckFailure {
  repoLabel: string;
  message: string;
}

export interface UpdateCheckResult {
  /** The refreshed projection, so no follow-up listing is needed. */
  catalogs: TrackedCatalog[];
  reposChecked: number;
  updatesAvailable: number;
  failures: UpdateCheckFailure[];
}

/** The upstream text for one tracked catalogue, alongside the local copy. */
export interface RemoteCatalogText {
  catalogId: string;
  localFilename: string;
  repoLabel: string;
  remoteToml: string;
  remoteBlobSha: string;
  localToml: string;
  /**
   * Git blob SHA-1 of the local file as reviewed. Echoed back on apply so the
   * backend can refuse to overwrite a file that changed in the meantime.
   */
  localSha?: string;
  localState: LocalState;
  /** Non-empty blocks applying. */
  validationErrors: string[];
  transmitFrameCount: number;
}

/**
 * Check tracked repositories for upstream changes.
 *
 * One head-commit request per repository+ref, and a tree listing only for those
 * that moved — so an unchanged repository is checked without downloading its whole
 * tree. Returns the refreshed tracked list, so no follow-up listing is needed.
 */
export async function checkCatalogUpdates(repoId?: string): Promise<UpdateCheckResult> {
  return await invoke<UpdateCheckResult>("check_catalog_updates", { repoId: repoId ?? null });
}

/** Fetch the upstream copy of a tracked catalogue, for review against the local one. */
export async function fetchRemoteCatalog(catalogId: string): Promise<RemoteCatalogText> {
  return await invoke<RemoteCatalogText>("fetch_remote_catalog", { catalogId });
}

/**
 * Overwrite the local catalogue with the upstream copy.
 *
 * The backend refuses when the file has local edits, or when it changed since
 * `expectedLocalSha` was read — so a file edited mid-review is never clobbered.
 */
export async function applyCatalogUpdate(
  catalogId: string,
  toml: string,
  expectedLocalSha: string | null,
): Promise<void> {
  await invoke("apply_catalog_update", { catalogId, toml, expectedLocalSha });
}

/** What a pull did. Discriminated on `kind`. */
export type PullOutcome =
  /** Upstream holds the bytes we last exchanged; nothing to take. */
  | { kind: "upToDate" }
  /** The local copy was replaced, because it had no edits of its own to lose. */
  | { kind: "applied"; filename: string }
  /** Both sides moved. Nothing was written — open the diff review. */
  | { kind: "needsReview" }
  /** The file is gone from the repository. */
  | { kind: "goneUpstream" };

/**
 * Pull one catalogue: fetch its repository, and take the update when it is safe to.
 *
 * The clean case — an unmodified local copy and a moved upstream — applies with no
 * dialog. `needsReview` is the only outcome that needs the user, and it is returned
 * rather than acted on so the caller decides how to present it.
 */
export async function pullCatalog(catalogId: string): Promise<PullOutcome> {
  return await invoke<PullOutcome>("pull_catalog", { catalogId });
}

/** Where a repository's clone is, and how far it has drifted from `origin`. */
export interface RepoStatus {
  repoId: string;
  /** Absolute path to the clone — a real git repository the user can open. */
  clonePath: string;
  /** False when nothing has been cloned yet. */
  cloned: boolean;
  branch: string;
  ahead: number;
  behind: number;
}

/** Local status of a repository's clone. No network. */
export async function repoStatus(repoId: string): Promise<RepoStatus> {
  return await invoke<RepoStatus>("repo_status", { repoId });
}

/**
 * Show a repository's clone in the OS file manager. Returns false when there is
 * nothing cloned yet, so the caller can say so rather than appearing to do nothing.
 */
export async function revealRepoClone(repoId: string): Promise<boolean> {
  const status = await repoStatus(repoId);
  if (status.cloned) await revealItemInDir(status.clonePath);
  return status.cloned;
}

/**
 * Tauri event carrying clone/fetch progress, so a first browse of a large
 * repository does not look like a hang. Payload is {@link GitProgress}.
 */
export const GIT_PROGRESS_EVENT = "catalog-git-progress";

export interface GitProgress {
  repoId: string;
  /** `clone` is the slow first time; `fetch` and `push` are quick. */
  phase: "clone" | "fetch" | "push";
  receivedObjects: number;
  totalObjects: number;
  receivedBytes: number;
}

// ── Account ──────────────────────────────────────────────────────────────────

/** The default host. Kept in one place so a future GitHub Enterprise host slots in. */
export const GIT_HOST = "github.com";

/** A validated account. The token itself never crosses the IPC boundary. */
export interface GitIdentity {
  host: string;
  login: string;
  scopes: string[];
  validatedAt: string;
}

/** Validate a personal access token and store it in the system keychain. */
export async function setGitToken(token: string, host = GIT_HOST): Promise<GitIdentity> {
  return await invoke<GitIdentity>("set_git_token", { host, token });
}

/** The cached identity, or null when no token is stored. */
export async function getGitIdentity(host = GIT_HOST): Promise<GitIdentity | null> {
  return await invoke<GitIdentity | null>("get_git_identity", { host });
}

/** Re-check the stored token against GitHub, refreshing login and scopes. */
export async function verifyGitToken(host = GIT_HOST): Promise<GitIdentity> {
  return await invoke<GitIdentity>("verify_git_token", { host });
}

/** Forget the stored token. */
export async function clearGitToken(host = GIT_HOST): Promise<void> {
  await invoke("clear_git_token", { host });
}

/** GitHub's token-creation page, pre-filled with the scope publishing needs. */
export async function gitTokenSetupUrl(): Promise<string> {
  return await invoke<string>("git_token_setup_url");
}

// ── Publish ──────────────────────────────────────────────────────────────────

export interface PublishRequest {
  /** Local catalogue filename within the decoder directory. */
  filename: string;
  repoUrl: string;
  targetPath?: string;
  /**
   * Branch to commit to. Omitted — the default — pushes straight to the base
   * branch, which is the ref this catalogue was pulled from. Naming one creates it.
   */
  branch?: string;
  commitMessage: string;
  prTitle?: string;
  prBody?: string;
  draft?: boolean;
  /** Open a pull request after pushing. Off by default. */
  openPr?: boolean;
  /** Set once the user has reviewed the secret-scan findings. */
  acceptSecretFindings?: boolean;
  requestId?: string;
}

/** A line that looks like it contains a credential. */
export interface SecretFinding {
  line: number;
  label: string;
  excerpt: string;
}

/** What publishing would do, computed with nothing written. */
export interface PublishPlan {
  upstream: string;
  targetPath: string;
  /** The branch that will be committed to; equals `baseBranch` for a direct push. */
  branch: string;
  /** The ref this catalogue was pulled from, else the repository default. */
  baseBranch: string;
  /**
   * What a branch would be called if a pull request is asked for without naming one.
   * A pure function of the filename, so it never goes stale as checkboxes move —
   * which is why the plan carries no `willOpenPr`. Derive that locally instead.
   */
  suggestedBranch: string;
  /** The account can push to the upstream directly, so no fork is needed. */
  canPushUpstream: boolean;
  forkNeeded: boolean;
  /** Content becomes public and permanent; drives the exposure warning. */
  targetIsPublic: boolean;
  contentBytes: number;
  /** Non-empty blocks publishing. */
  validationErrors: string[];
  secretFindings: SecretFinding[];
  transmitFrameCount: number;
  existingPrUrl?: string;
}

export type PublishAction = "created" | "updated" | "committed";

export interface PublishResult {
  action: PublishAction;
  prUrl?: string;
  prNumber?: number;
  commitUrl?: string;
  headOwner: string;
  branch: string;
  reusedBranch: boolean;
}

/** Tauri event name for step-by-step publish progress. */
export const PUBLISH_PROGRESS_EVENT = "catalog-publish-progress";

export type PublishStep =
  | "validate"
  | "auth"
  | "fork"
  | "branch"
  | "commit"
  | "pr"
  | "done";

export interface PublishProgress {
  requestId: string;
  step: PublishStep;
  detail?: string;
}

/** What publishing would do — validation, secret scan, fork need, visibility. */
export async function preflightPublish(req: PublishRequest): Promise<PublishPlan> {
  return await invoke<PublishPlan>("preflight_publish", { req });
}

/** Publish: branch, commit, and (unless commit-only) open or update a pull request. */
export async function publishCatalog(req: PublishRequest): Promise<PublishResult> {
  return await invoke<PublishResult>("publish_catalog", { req });
}

/** What to create a repository as. Private unless deliberately made public. */
export interface NewRepoRequest {
  name: string;
  description?: string | null;
  private: boolean;
}

/** Create a repository to publish into. */
export async function createCatalogRepo(req: NewRepoRequest): Promise<RepoInfo> {
  return await invoke<RepoInfo>("create_catalog_repo", { req });
}

export interface TrackedPr {
  number: number;
  url: string;
  merged: boolean;
}

/** Re-check a tracked catalogue's pull request — open, or merged. */
export async function refreshPrStatus(catalogId: string): Promise<TrackedPr | null> {
  return await invoke<TrackedPr | null>("refresh_pr_status", { catalogId });
}
