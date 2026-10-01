// Generated from the Rust serde types by `npm run gen:types`. Do not edit.
import type { SyncStatus } from "./SyncStatus";

/**
 * A local catalogue's provenance and sync state, for the settings list.
 */
export type TrackedCatalog = { id: string, localFilename: string, repoId: string, repoLabel: string, remotePath: string, gitRef: string, 
/**
 * Where this catalogue stands against its repository.
 *
 * The collapse, not its two inputs: shipping `local_state` and `remote_state`
 * beside it invites a consumer to re-derive rather than ask, which is the exact
 * drift `SyncStatus::collapse` exists to make impossible.
 */
syncStatus: SyncStatus, webUrl?: string, prUrl?: string, prNumber?: number, prMerged: boolean, };
