// Generated from the Rust serde types by `npm run gen:types`. Do not edit.
import type { CommunityRepoView } from "./CommunityRepoView";
import type { SavedRepoView } from "./SavedRepoView";
import type { TrackedCatalog } from "./TrackedCatalog";

export type CatalogSourcesView = { catalogs: Array<TrackedCatalog>, savedRepos: Array<SavedRepoView>, favouriteRepoId: string | null, 
/**
 * Other people's repositories — the ones that ship with WireTAP plus any the
 * user added. Never a publish target; see `community`.
 */
communityRepos: Array<CommunityRepoView>, 
/**
 * Whether a token is stored. The token itself never leaves Rust.
 */
hasToken: boolean, login?: string, };
