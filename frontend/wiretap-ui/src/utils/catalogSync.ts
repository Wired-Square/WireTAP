// ui/src/utils/catalogSync.ts
/**
 * Questions a UI asks *about* a catalogue's sync status.
 *
 * The status itself is no longer derived here. The backend reports two orthogonal
 * facts — how the local file compares with the bytes last exchanged, and how the
 * remote compares with them — and collapses them into one label in
 * `catalog_share::registry::SyncStatus::collapse`, which arrives on every catalogue.
 * That move is what lets the catalogue picker render an icon without subscribing to
 * the sharing store, and it is why there is no second collapse to drift from the
 * first. Do not reintroduce one here.
 *
 * What belongs in TypeScript is below: these are presentation questions, not
 * provenance ones.
 */
import type { CatalogSyncStatus } from "../api/catalogShare";

/** Is there anything to send upstream? Drives whether Push is worth offering. */
export function hasLocalChanges(status: CatalogSyncStatus): boolean {
  return status === "localAhead" || status === "diverged";
}

/** Is there anything to take from upstream? */
export function hasRemoteChanges(status: CatalogSyncStatus): boolean {
  return status === "remoteAhead" || status === "diverged";
}

/**
 * Does resolving this need the user to choose? Both sides moved, so neither a push
 * nor a pull is safe on its own — which is why it sorts ahead of the rest.
 */
export function needsDecision(status: CatalogSyncStatus): boolean {
  return status === "diverged";
}
