// Generated from the Rust serde types by `npm run gen:types`. Do not edit.
import type { TrackedCatalog } from "./TrackedCatalog";
import type { UpdateCheckFailure } from "./UpdateCheckFailure";

/**
 * Outcome of checking tracked repositories for upstream changes.
 */
export type UpdateCheckResult = { 
/**
 * The refreshed projection, so the caller needs no follow-up listing.
 */
catalogs: Array<TrackedCatalog>, reposChecked: number, updatesAvailable: number, 
/**
 * Repositories that could not be reached, with why.
 */
failures: Array<UpdateCheckFailure>, };
