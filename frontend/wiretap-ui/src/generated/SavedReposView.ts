// Generated from the Rust serde types by `npm run gen:types`. Do not edit.
import type { SavedRepoView } from "./SavedRepoView";

/**
 * The saved list after a mutation, so callers patch state instead of re-listing.
 *
 * Returned rather than left to a follow-up `list_catalog_sources`, which
 * reconciles the decoder directory and hashes every tracked catalogue on disk —
 * far too much work to answer "which repositories are saved?".
 */
export type SavedReposView = { savedRepos: Array<SavedRepoView>, favouriteRepoId: string | null, };
