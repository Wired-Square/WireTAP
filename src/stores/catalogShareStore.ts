// ui/src/stores/catalogShareStore.ts
// Store for sharing catalogue decoders over git (GitHub).
//
// A store of its own rather than a slice on catalogEditorStore: Settings browses
// and tracks sources while the Catalog editor publishes, so the state is not
// editor-local, and catalogEditorStore is already large.

import { create } from "zustand";
import {
  applyCatalogUpdate,
  asShareError,
  browseCatalogRepo,
  checkCatalogUpdates,
  clearGitToken,
  createCatalogRepo,
  fetchRemoteCatalog,
  pullCatalog,
  forgetCatalogRepo,
  forgetCatalogSource,
  getGitIdentity,
  importRemoteCatalogs,
  listCatalogSources,
  parseCatalogSourceUrl,
  preflightPublish,
  publishCatalog,
  refreshPrStatus,
  resolveRemoteCatalogs,
  saveCatalogRepo,
  setFavouriteCatalogRepo,
  setGitToken,
  verifyGitToken,
  type CatalogSource,
  type CollisionPolicy,
  type GitIdentity,
  type ImportResult,
  type PublishPlan,
  type PublishRequest,
  type PublishResult,
  type PublishStep,
  type RemoteCatalog,
  type RemoteCatalogText,
  type RepoBrowse,
  type RepoInfo,
  type SavedRepo,
  type SavedRepoView,
  type ShareError,
  type TrackedCatalog,
  type UpdateCheckResult,
  type PullOutcome,
} from "../api/catalogShare";
import { tlog } from "../api/settings";

/** How many catalogues to resolve names for eagerly after a browse. */
const EAGER_RESOLVE_LIMIT = 25;

interface BrowseSlice {
  /** The URL in the input field. */
  url: string;
  /** Live parse of `url` before a browse has run, for immediate feedback. */
  parsed: CatalogSource | null;
  parseError: string | null;
  loading: boolean;
  error: ShareError | null;
  result: RepoBrowse | null;
  /** Resolved metadata keyed by repo path. */
  resolved: Record<string, RemoteCatalog>;
  resolving: boolean;
  /**
   * A failure to read catalogue details. Kept apart from `error` because the list
   * still works without it — only a browse failure is fatal to the dialog.
   */
  resolveError: ShareError | null;
}

interface ImportSlice {
  inFlight: boolean;
  results: ImportResult[] | null;
  error: ShareError | null;
}

interface AccountSlice {
  identity: GitIdentity | null;
  busy: boolean;
  error: ShareError | null;
}

interface PublishSlice {
  /** Preflight outcome: what publishing would do, with nothing written. */
  plan: PublishPlan | null;
  planning: boolean;
  inFlight: boolean;
  /** Steps completed so far, driven by the backend's progress events. */
  steps: PublishStep[];
  currentStep: PublishStep | null;
  detail: string | null;
  result: PublishResult | null;
  error: ShareError | null;
  /** Set once the user has reviewed any secret-scan findings. */
  secretsAcknowledged: boolean;
}

interface UpdateSlice {
  checking: boolean;
  /**
   * Summary of the last check. Deliberately without its `catalogs` — those go
   * straight to `tracked`, and keeping a second copy here would freeze at check
   * time while the real list moved on.
   */
  lastResult: Omit<UpdateCheckResult, "catalogs"> | null;
  /** A failed check. Rendered next to the check button. */
  checkError: ShareError | null;
  /** The catalogue currently being reviewed, once its remote text has arrived. */
  reviewing: RemoteCatalogText | null;
  loadingReview: boolean;
  applying: boolean;
  /** A failed review or apply. Rendered inside the review dialog. */
  reviewError: ShareError | null;
}

interface CatalogShareState {
  browse: BrowseSlice;
  /** Selected repo paths for import. */
  selection: string[];
  onCollision: CollisionPolicy;
  importState: ImportSlice;
  account: AccountSlice;
  publishState: PublishSlice;
  updates: UpdateSlice;

  tracked: TrackedCatalog[];
  savedRepos: SavedRepoView[];
  favouriteRepoId: string | null;
  /** Last saved-repo failure. Its own field because both dialogs mutate the list,
   *  and `browse.error` is only rendered by one of them. */
  reposError: ShareError | null;
  hasToken: boolean;
  login: string | null;
  sourcesLoading: boolean;

  setUrl: (url: string) => void;
  /** Parse the current URL for immediate feedback, without hitting the network. */
  validateUrl: () => Promise<void>;
  /** Browse the URL in `browse.url`, optionally narrowed to a saved repo's scope. */
  runBrowse: (scope?: { gitRef?: string; directory?: string }) => Promise<void>;
  clearBrowse: () => void;

  toggleSelection: (path: string) => void;
  selectAllValid: () => void;
  setCollisionPolicy: (policy: CollisionPolicy) => void;

  /** Fetch names/validity for the given paths (or the first page after a browse). */
  resolveNames: (paths?: string[]) => Promise<void>;
  runImport: () => Promise<ImportResult[]>;

  loadSources: () => Promise<void>;
  forgetSource: (catalogId: string) => Promise<void>;
  /** Save a repository (or update the saved one with the same id). */
  saveRepo: (
    input: string,
    opts?: { label?: string; gitRef?: string; directory?: string },
  ) => Promise<SavedRepo | null>;
  forgetRepo: (repoId: string) => Promise<void>;
  /** Star one saved repository as the default publish target, or `null` to clear. */
  setFavouriteRepo: (repoId: string | null) => Promise<void>;
  checkPrStatus: (catalogId: string) => Promise<void>;

  /** Check tracked repositories for upstream changes. */
  runUpdateCheck: (repoId?: string) => Promise<UpdateCheckResult | null>;
  /**
   * Pull one catalogue. Applies straight away when the local copy has nothing to
   * lose; returns `needsReview` for the caller to open the diff on.
   */
  pullCatalog: (catalogId: string) => Promise<PullOutcome | null>;
  /** Catalogue ids with a pull in flight, so their rows can disable the action. */
  pulling: string[];
  /**
   * Per-catalogue pull failures, keyed by id. Kept apart from `updates.checkError`:
   * that one renders as a view-level banner under the "everything is up to date"
   * summary, so a single row's failure would show up unattributed next to a stale
   * success message, and nothing but a fresh update check would ever clear it.
   */
  pullErrors: Record<string, ShareError>;
  /** Load the upstream text for review. */
  loadReview: (catalogId: string) => Promise<RemoteCatalogText | null>;
  /** Overwrite the local file with the reviewed upstream copy. */
  applyUpdate: (
    catalogId: string,
    toml: string,
    expectedLocalSha: string | null,
  ) => Promise<boolean>;
  clearReview: () => void;

  loadIdentity: () => Promise<void>;
  connectAccount: (token: string) => Promise<boolean>;
  verifyAccount: () => Promise<void>;
  disconnectAccount: () => Promise<void>;

  /** Compute what publishing would do, without writing anything. */
  planPublish: (req: PublishRequest) => Promise<PublishPlan | null>;
  acknowledgeSecrets: () => void;
  runPublish: (req: PublishRequest) => Promise<PublishResult | null>;
  /** Applied from the backend's Tauri progress events. */
  notePublishProgress: (step: PublishStep, detail?: string) => void;
  clearPublish: () => void;
  createRepo: (
    name: string,
    description: string | null,
    isPrivate: boolean,
  ) => Promise<RepoInfo | null>;
}

const emptyBrowse: BrowseSlice = {
  url: "",
  parsed: null,
  parseError: null,
  loading: false,
  error: null,
  result: null,
  resolved: {},
  resolving: false,
  resolveError: null,
};

const emptyImport: ImportSlice = { inFlight: false, results: null, error: null };

const emptyUpdates: UpdateSlice = {
  checking: false,
  lastResult: null,
  checkError: null,
  reviewing: null,
  loadingReview: false,
  applying: false,
  reviewError: null,
};

const emptyPublish: PublishSlice = {
  plan: null,
  planning: false,
  inFlight: false,
  steps: [],
  currentStep: null,
  detail: null,
  result: null,
  error: null,
  secretsAcknowledged: false,
};

/** Paths with a resolve request in flight, so concurrent callers don't double-fetch. */
const inFlightResolves = new Set<string>();

export const useCatalogShareStore = create<CatalogShareState>((set, get) => ({
  browse: emptyBrowse,
  selection: [],
  onCollision: "keepBoth",
  importState: emptyImport,
  account: { identity: null, busy: false, error: null },
  publishState: emptyPublish,
  updates: emptyUpdates,

  tracked: [],
  savedRepos: [],
  favouriteRepoId: null,
  reposError: null,
  hasToken: false,
  login: null,
  sourcesLoading: false,

  setUrl: (url) =>
    set((s) => ({
      // Clear the parse hint too: leaving it would describe the previous URL while
      // the user types a new one.
      browse: { ...s.browse, url, parsed: null, parseError: null, error: null },
    })),

  validateUrl: async () => {
    const url = get().browse.url.trim();
    if (!url) {
      set((s) => ({ browse: { ...s.browse, parsed: null, parseError: null } }));
      return;
    }
    try {
      const parsed = await parseCatalogSourceUrl(url);
      set((s) => ({ browse: { ...s.browse, parsed, parseError: null } }));
    } catch (error) {
      set((s) => ({
        browse: { ...s.browse, parsed: null, parseError: asShareError(error).message },
      }));
    }
  },

  runBrowse: async (scope) => {
    const url = get().browse.url.trim();
    if (!url) return;
    set((s) => ({
      browse: {
        ...s.browse,
        loading: true,
        error: null,
        resolveError: null,
        result: null,
        resolved: {},
      },
      selection: [],
      importState: emptyImport,
    }));
    try {
      const result = await browseCatalogRepo(url, scope);
      set((s) => ({
        // The repo card now carries the identity, so the parse hint is redundant.
        browse: { ...s.browse, loading: false, result, parsed: null },
      }));
      // Resolve the first page eagerly so the list shows real catalogue names
      // rather than bare paths. Deliberately capped: one fetch per file.
      const paths = result.entries.slice(0, EAGER_RESOLVE_LIMIT).map((e) => e.path);
      if (paths.length > 0) await get().resolveNames(paths);
    } catch (error) {
      const shareError = asShareError(error);
      tlog.info(`[catalogShare] browse failed: ${shareError.kind} ${shareError.message}`);
      set((s) => ({ browse: { ...s.browse, loading: false, error: shareError } }));
    }
  },

  clearBrowse: () => {
    inFlightResolves.clear();
    set({ browse: emptyBrowse, selection: [], importState: emptyImport });
  },

  toggleSelection: (path) =>
    set((s) => ({
      selection: s.selection.includes(path)
        ? s.selection.filter((p) => p !== path)
        : [...s.selection, path],
    })),

  selectAllValid: () => {
    const { browse } = get();
    if (!browse.result) return;
    // Only select what we know parses — an unresolved entry has not been checked,
    // and a known-invalid one would fail the import anyway.
    set({
      selection: browse.result.entries
        .filter((e) => browse.resolved[e.path]?.valid)
        .map((e) => e.path),
    });
  },

  setCollisionPolicy: (onCollision) => set({ onCollision }),

  resolveNames: async (paths) => {
    const { browse } = get();
    if (!browse.result) return;
    const wanted = (paths ?? browse.result.entries.map((e) => e.path)).filter(
      (p) => !browse.resolved[p] && !inFlightResolves.has(p),
    );
    if (wanted.length === 0) return;

    wanted.forEach((p) => inFlightResolves.add(p));
    set((s) => ({ browse: { ...s.browse, resolving: true, resolveError: null } }));
    try {
      const resolved = await resolveRemoteCatalogs(
        browse.url.trim(),
        browse.result.gitRef,
        wanted,
      );
      set((s) => ({
        browse: {
          ...s.browse,
          resolving: false,
          resolved: {
            ...s.browse.resolved,
            ...Object.fromEntries(resolved.map((r) => [r.path, r])),
          },
        },
      }));
    } catch (error) {
      const shareError = asShareError(error);
      tlog.info(`[catalogShare] resolve failed: ${shareError.message}`);
      set((s) => ({ browse: { ...s.browse, resolving: false, resolveError: shareError } }));
    } finally {
      wanted.forEach((p) => inFlightResolves.delete(p));
    }
  },

  runImport: async () => {
    const { browse, selection, onCollision } = get();
    if (!browse.result || selection.length === 0) return [];
    set({ importState: { inFlight: true, results: null, error: null } });
    try {
      const results = await importRemoteCatalogs({
        input: browse.url.trim(),
        gitRef: browse.result.gitRef,
        paths: selection,
        onCollision,
      });
      set({ importState: { inFlight: false, results, error: null } });
      // The backend refreshed its catalogue cache; refresh our provenance view.
      await get().loadSources();
      return results;
    } catch (error) {
      const shareError = asShareError(error);
      tlog.info(`[catalogShare] import failed: ${shareError.message}`);
      set({ importState: { inFlight: false, results: null, error: shareError } });
      return [];
    }
  },

  loadSources: async () => {
    set({ sourcesLoading: true });
    try {
      const view = await listCatalogSources();
      set({
        tracked: view.catalogs,
        savedRepos: view.savedRepos,
        favouriteRepoId: view.favouriteRepoId ?? null,
        hasToken: view.hasToken,
        login: view.login ?? null,
        sourcesLoading: false,
      });
    } catch (error) {
      tlog.info(`[catalogShare] loadSources failed: ${asShareError(error).message}`);
      set({ sourcesLoading: false });
    }
  },

  forgetSource: async (catalogId) => {
    try {
      await forgetCatalogSource(catalogId);
      set((s) => ({ tracked: s.tracked.filter((c) => c.id !== catalogId) }));
    } catch (error) {
      tlog.info(`[catalogShare] forget failed: ${asShareError(error).message}`);
    }
  },

  saveRepo: async (input, opts) => {
    try {
      const { saved, savedRepos, favouriteRepoId } = await saveCatalogRepo(input, opts);
      // The command returns the refreshed list, so there is nothing to re-list —
      // and the backend keeps owning the rules (first save becomes the favourite).
      set({ savedRepos, favouriteRepoId: favouriteRepoId ?? null, reposError: null });
      return saved;
    } catch (error) {
      set({ reposError: asShareError(error) });
      return null;
    }
  },

  forgetRepo: async (repoId) => {
    try {
      const { savedRepos, favouriteRepoId } = await forgetCatalogRepo(repoId);
      set({ savedRepos, favouriteRepoId: favouriteRepoId ?? null, reposError: null });
    } catch (error) {
      set({ reposError: asShareError(error) });
    }
  },

  setFavouriteRepo: async (repoId) => {
    const previous = get().favouriteRepoId;
    // Optimistic: a star should light immediately. The command reports a refusal,
    // so the rollback below is reachable rather than decorative.
    set({ favouriteRepoId: repoId });
    try {
      const { savedRepos, favouriteRepoId } = await setFavouriteCatalogRepo(repoId);
      set({ savedRepos, favouriteRepoId: favouriteRepoId ?? null, reposError: null });
    } catch (error) {
      set({ favouriteRepoId: previous, reposError: asShareError(error) });
    }
  },

  checkPrStatus: async (catalogId) => {
    try {
      const pr = await refreshPrStatus(catalogId);
      if (!pr) return;
      set((s) => ({
        tracked: s.tracked.map((c) =>
          c.id === catalogId
            ? { ...c, prNumber: pr.number, prUrl: pr.url, prMerged: pr.merged }
            : c,
        ),
      }));
    } catch (error) {
      tlog.info(`[catalogShare] PR status check failed: ${asShareError(error).message}`);
    }
  },

  // ── Updates ────────────────────────────────────────────────────────────────

  runUpdateCheck: async (repoId) => {
    set((s) => ({ updates: { ...s.updates, checking: true, checkError: null } }));
    try {
      const { catalogs, ...summary } = await checkCatalogUpdates(repoId);
      // The check returns the refreshed projection, so no follow-up listing.
      set((s) => ({
        updates: { ...s.updates, checking: false, lastResult: summary },
        tracked: catalogs,
      }));
      return { catalogs, ...summary };
    } catch (error) {
      const shareError = asShareError(error);
      tlog.info(`[catalogShare] update check failed: ${shareError.message}`);
      set((s) => ({ updates: { ...s.updates, checking: false, checkError: shareError } }));
      return null;
    }
  },

  pulling: [],
  pullErrors: {},

  pullCatalog: async (catalogId) => {
    if (get().pulling.includes(catalogId)) return null;
    set((s) => ({
      pulling: [...s.pulling, catalogId],
      // Clear last time's failure for this row as the retry starts.
      pullErrors: Object.fromEntries(
        Object.entries(s.pullErrors).filter(([id]) => id !== catalogId),
      ),
    }));
    try {
      const outcome = await pullCatalog(catalogId);
      // Refresh whatever happened: even `upToDate` and `needsReview` record a fresh
      // remote sha on the backend, so the badge would otherwise stay stale.
      await get().loadSources();
      return outcome;
    } catch (error) {
      const shareError = asShareError(error);
      tlog.info(`[catalogShare] pull failed: ${shareError.message}`);
      set((s) => ({ pullErrors: { ...s.pullErrors, [catalogId]: shareError } }));
      return null;
    } finally {
      set((s) => ({ pulling: s.pulling.filter((id) => id !== catalogId) }));
    }
  },

  loadReview: async (catalogId) => {
    set((s) => ({
      updates: { ...s.updates, loadingReview: true, reviewError: null, reviewing: null },
    }));
    try {
      const reviewing = await fetchRemoteCatalog(catalogId);
      set((s) => ({ updates: { ...s.updates, loadingReview: false, reviewing } }));
      return reviewing;
    } catch (error) {
      const shareError = asShareError(error);
      tlog.info(`[catalogShare] fetch remote failed: ${shareError.message}`);
      set((s) => ({
        updates: { ...s.updates, loadingReview: false, reviewError: shareError },
      }));
      return null;
    }
  },

  applyUpdate: async (catalogId, toml, expectedLocalSha) => {
    set((s) => ({ updates: { ...s.updates, applying: true, reviewError: null } }));
    try {
      await applyCatalogUpdate(catalogId, toml, expectedLocalSha);
      set((s) => ({ updates: { ...s.updates, applying: false, reviewing: null } }));
      await get().loadSources();
      return true;
    } catch (error) {
      const shareError = asShareError(error);
      tlog.info(`[catalogShare] apply update failed: ${shareError.message}`);
      set((s) => ({ updates: { ...s.updates, applying: false, reviewError: shareError } }));
      return false;
    }
  },

  clearReview: () =>
    set((s) => ({ updates: { ...s.updates, reviewing: null, reviewError: null } })),

  // ── Account ────────────────────────────────────────────────────────────────

  loadIdentity: async () => {
    try {
      const identity = await getGitIdentity();
      set((s) => ({
        account: { ...s.account, identity },
        hasToken: identity !== null,
        login: identity?.login ?? null,
      }));
    } catch (error) {
      tlog.info(`[catalogShare] identity load failed: ${asShareError(error).message}`);
    }
  },

  connectAccount: async (token) => {
    set((s) => ({ account: { ...s.account, busy: true, error: null } }));
    try {
      // Validated server-side before storing, so a typo never becomes a persisted
      // credential that fails later at publish time.
      const identity = await setGitToken(token);
      set({
        account: { identity, busy: false, error: null },
        hasToken: true,
        login: identity.login,
      });
      return true;
    } catch (error) {
      const shareError = asShareError(error);
      set((s) => ({ account: { ...s.account, busy: false, error: shareError } }));
      return false;
    }
  },

  verifyAccount: async () => {
    set((s) => ({ account: { ...s.account, busy: true, error: null } }));
    try {
      const identity = await verifyGitToken();
      set({
        account: { identity, busy: false, error: null },
        hasToken: true,
        login: identity.login,
      });
    } catch (error) {
      // hasToken stays true: the entry is still in the keychain, so the message can
      // be "token rejected" rather than "no token".
      set({
        account: { identity: null, busy: false, error: asShareError(error) },
        login: null,
      });
    }
  },

  disconnectAccount: async () => {
    try {
      await clearGitToken();
    } catch (error) {
      tlog.info(`[catalogShare] disconnect failed: ${asShareError(error).message}`);
    }
    set({
      account: { identity: null, busy: false, error: null },
      hasToken: false,
      login: null,
    });
  },

  // ── Publish ────────────────────────────────────────────────────────────────

  planPublish: async (req) => {
    set((s) => ({
      publishState: {
        ...emptyPublish,
        planning: true,
        // Keep an acknowledgement across a re-plan of the same file.
        secretsAcknowledged: s.publishState.secretsAcknowledged,
      },
    }));
    try {
      const plan = await preflightPublish(req);
      set((s) => ({ publishState: { ...s.publishState, planning: false, plan } }));
      return plan;
    } catch (error) {
      const shareError = asShareError(error);
      tlog.info(`[catalogShare] preflight failed: ${shareError.message}`);
      set((s) => ({
        publishState: { ...s.publishState, planning: false, error: shareError },
      }));
      return null;
    }
  },

  acknowledgeSecrets: () =>
    set((s) => ({ publishState: { ...s.publishState, secretsAcknowledged: true } })),

  runPublish: async (req) => {
    set((s) => ({
      publishState: {
        ...s.publishState,
        inFlight: true,
        error: null,
        result: null,
        steps: [],
        currentStep: null,
        detail: null,
      },
    }));
    try {
      const result = await publishCatalog({
        ...req,
        acceptSecretFindings: get().publishState.secretsAcknowledged,
      });
      set((s) => ({
        publishState: { ...s.publishState, inFlight: false, result, currentStep: null },
      }));
      // The commit updated synced_sha, so the tracked view's sync state has moved.
      await get().loadSources();
      return result;
    } catch (error) {
      const shareError = asShareError(error);
      tlog.info(`[catalogShare] publish failed: ${shareError.kind} ${shareError.message}`);
      set((s) => ({
        publishState: { ...s.publishState, inFlight: false, error: shareError },
      }));
      return null;
    }
  },

  notePublishProgress: (step, detail) =>
    set((s) => ({
      publishState: {
        ...s.publishState,
        currentStep: step,
        detail: detail ?? null,
        steps: s.publishState.steps.includes(step)
          ? s.publishState.steps
          : [...s.publishState.steps, step],
      },
    })),

  clearPublish: () => set({ publishState: emptyPublish }),

  createRepo: async (name, description, isPrivate) => {
    set((s) => ({ account: { ...s.account, busy: true, error: null } }));
    try {
      const repo = await createCatalogRepo({ name, description, private: isPrivate });
      set((s) => ({ account: { ...s.account, busy: false, error: null } }));
      return repo;
    } catch (error) {
      const shareError = asShareError(error);
      set((s) => ({ account: { ...s.account, busy: false, error: shareError } }));
      return null;
    }
  },
}));
