// ui/src/api/catalogShare.ts
// Sharing catalogue decoders over git (GitHub REST).
//
// These are Tauri `invoke` commands rather than `catalog.*` WebSocket commands:
// the WS surface is deliberately pure (no filesystem, settings or keychain) and
// has a 10s timeout that network work would blow through. The app CSP also blocks
// direct calls to api.github.com from the webview, so all HTTP lives in Rust.

import { invoke } from "@tauri-apps/api/core";
import { revealItemInDir } from "@tauri-apps/plugin-opener";

import type { CatalogSource } from "../generated/CatalogSource";
import type { CatalogSourcesView } from "../generated/CatalogSourcesView";
import type { CollisionPolicy } from "../generated/CollisionPolicy";
import type { CommunityReposView } from "../generated/CommunityReposView";
import type { CommunityRepoView } from "../generated/CommunityRepoView";
import type { FileCommit } from "../generated/FileCommit";
import type { GitIdentity } from "../generated/GitIdentity";
import type { GitProgress } from "../generated/GitProgress";
import type { ImportOutcome } from "../generated/ImportOutcome";
import type { ImportRequest } from "../generated/ImportRequest";
import type { ImportResult } from "../generated/ImportResult";
import type { LocalState } from "../generated/LocalState";
import type { PublishAction } from "../generated/PublishAction";
import type { PublishDiff } from "../generated/PublishDiff";
import type { PublishDiffRequest } from "../generated/PublishDiffRequest";
import type { PublishPlan } from "../generated/PublishPlan";
import type { PublishProgress } from "../generated/PublishProgress";
import type { PublishRequest } from "../generated/PublishRequest";
import type { PublishResult } from "../generated/PublishResult";
import type { PullOutcome } from "../generated/PullOutcome";
import type { RemoteCatalog } from "../generated/RemoteCatalog";
import type { RemoteCatalogText } from "../generated/RemoteCatalogText";
import type { RemoteEntry } from "../generated/RemoteEntry";
import type { RepoBrowse } from "../generated/RepoBrowse";
import type { RepoInfo } from "../generated/RepoInfo";
import type { RepoStatus } from "../generated/RepoStatus";
import type { SavedRepo } from "../generated/SavedRepo";
import type { SavedReposView } from "../generated/SavedReposView";
import type { SavedRepoView } from "../generated/SavedRepoView";
import type { SaveRepoResult } from "../generated/SaveRepoResult";
import type { SecretFinding } from "../generated/SecretFinding";
import type { ShareError } from "../generated/ShareError";
import type { ShareErrorKind } from "../generated/ShareErrorKind";
import type { SourceKind } from "../generated/SourceKind";
import type { TrackedCatalog } from "../generated/TrackedCatalog";
import type { TrackedPr } from "../generated/TrackedPr";
import type { UpdateCheckFailure } from "../generated/UpdateCheckFailure";
import type { UpdateCheckResult } from "../generated/UpdateCheckResult";
import type { VersionBump } from "../generated/VersionBump";
import type { NewRepo as NewRepoRequest } from "../generated/NewRepo";
import type { SyncStatus as CatalogSyncStatus } from "../generated/SyncStatus";

export type {
  CatalogSource,
  CatalogSourcesView,
  CatalogSyncStatus,
  CollisionPolicy,
  CommunityReposView,
  CommunityRepoView,
  FileCommit,
  GitIdentity,
  GitProgress,
  ImportOutcome,
  ImportRequest,
  ImportResult,
  LocalState,
  NewRepoRequest,
  PublishAction,
  PublishDiff,
  PublishDiffRequest,
  PublishPlan,
  PublishProgress,
  PublishRequest,
  PublishResult,
  PullOutcome,
  RemoteCatalog,
  RemoteCatalogText,
  RemoteEntry,
  RepoBrowse,
  RepoInfo,
  RepoStatus,
  SavedRepo,
  SavedReposView,
  SavedRepoView,
  SaveRepoResult,
  SecretFinding,
  ShareError,
  ShareErrorKind,
  SourceKind,
  TrackedCatalog,
  TrackedPr,
  UpdateCheckFailure,
  UpdateCheckResult,
  VersionBump,
};

export type PublishStep = PublishProgress["step"];

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

/** What to show for a repository in a list or dropdown. */
export function savedRepoName(repo: SavedRepo): string {
  return repo.label?.trim() || `${repo.owner}/${repo.repo}`;
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

/**
 * Adopt a file that is already upstream as this catalogue's provenance, pushing
 * nothing.
 *
 * The way out of the one dead end in the journey: a catalogue nothing tracks whose
 * bytes upstream already match cannot be pushed (there is no commit to make), so
 * without this there is no route to being tracked at all.
 */
export async function linkCatalogSource(
  filename: string,
  repoUrl: string,
  remotePath: string,
  gitRef?: string,
): Promise<TrackedCatalog> {
  return await invoke<TrackedCatalog>("link_catalog_source", {
    filename,
    repoUrl,
    remotePath,
    gitRef: gitRef ?? null,
  });
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

// ── Community repositories ───────────────────────────────────────────────────

/**
 * Add a community repository, or update the one already held under the same id.
 * Same inference from the URL as `saveCatalogRepo`.
 */
export async function saveCommunityRepo(
  input: string,
  opts: { label?: string; gitRef?: string; directory?: string } = {},
): Promise<CommunityReposView> {
  return await invoke<CommunityReposView>("save_community_repo", {
    input,
    label: opts.label ?? null,
    gitRef: opts.gitRef ?? null,
    directory: opts.directory ?? null,
  });
}

/** Drop a community repository the user added. Rejected for a built-in. */
export async function forgetCommunityRepo(repoId: string): Promise<CommunityReposView> {
  return await invoke<CommunityReposView>("forget_community_repo", { repoId });
}

// ── Updates ──────────────────────────────────────────────────────────────────

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

// ── Account ──────────────────────────────────────────────────────────────────

/** The default host. Kept in one place so a future GitHub Enterprise host slots in. */
export const GIT_HOST = "github.com";

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

/** Tauri event name for step-by-step publish progress. */
export const PUBLISH_PROGRESS_EVENT = "catalog-publish-progress";

/** What publishing would do — validation, secret scan, fork need, visibility. */
export async function preflightPublish(req: PublishRequest): Promise<PublishPlan> {
  return await invoke<PublishPlan>("preflight_publish", { req });
}

/** Publish: branch, commit, and (unless commit-only) open or update a pull request. */
export async function publishCatalog(req: PublishRequest): Promise<PublishResult> {
  return await invoke<PublishResult>("publish_catalog", { req });
}

/**
 * What a push would change upstream.
 *
 * Answered entirely from the clone `preflightPublish` already fetched, so this is
 * free to call as the branch and path controls move. Separate from the plan because
 * the plan deliberately does not re-run for those controls, and because the file
 * text is far too large to ship on something fetched this often.
 */
export async function publishDiff(req: PublishDiffRequest): Promise<PublishDiff> {
  return await invoke<PublishDiff>("publish_diff", { req });
}

/** Create a repository to publish into. */
export async function createCatalogRepo(req: NewRepoRequest): Promise<RepoInfo> {
  return await invoke<RepoInfo>("create_catalog_repo", { req });
}

/** Re-check a tracked catalogue's pull request — open, or merged. */
export async function refreshPrStatus(catalogId: string): Promise<TrackedPr | null> {
  return await invoke<TrackedPr | null>("refresh_pr_status", { catalogId });
}
