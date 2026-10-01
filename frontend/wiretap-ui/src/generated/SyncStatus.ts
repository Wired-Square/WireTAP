// Generated from the Rust serde types by `npm run gen:types`. Do not edit.

/**
 * How a local catalogue stands against its repository, as one answer.
 *
 * [`LocalState`] and [`RemoteState`] are orthogonal on purpose — they are what blob
 * SHAs can prove without guessing — but every surface that lists catalogues wants a
 * single label, and the picker and the settings row must never disagree about which
 * one it is. So the collapse happens exactly once, in [`CatalogEntry::sync_status_of`].
 */
export type SyncStatus = "localOnly" | "inSync" | "localAhead" | "remoteAhead" | "diverged" | "missing" | "unchecked";
