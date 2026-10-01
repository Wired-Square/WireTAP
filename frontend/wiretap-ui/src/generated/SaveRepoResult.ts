// Generated from the Rust serde types by `npm run gen:types`. Do not edit.
import type { SavedRepo } from "./SavedRepo";
import type { SavedRepoView } from "./SavedRepoView";

/**
 * A saved repository plus the refreshed list it now belongs to.
 */
export type SaveRepoResult = { saved: SavedRepo, savedRepos: Array<SavedRepoView>, favouriteRepoId: string | null, };
