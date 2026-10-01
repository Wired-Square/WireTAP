// Generated from the Rust serde types by `npm run gen:types`. Do not edit.
import type { CatalogSource } from "./CatalogSource";
import type { RemoteEntry } from "./RemoteEntry";
import type { RepoInfo } from "./RepoInfo";

/**
 * Result of pointing the app at a repository URL.
 */
export type RepoBrowse = { source: CatalogSource, repo: RepoInfo, 
/**
 * The ref actually used, with the repository default resolved.
 */
gitRef: string, entries: Array<RemoteEntry>, 
/**
 * Candidates beyond the display cap that were dropped.
 */
dropped: number, authenticated: boolean, };
