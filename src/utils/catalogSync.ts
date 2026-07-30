// ui/src/utils/catalogSync.ts
/**
 * One derived answer to "how does my copy compare with the repository?".
 *
 * The backend reports two orthogonal facts — how the local file compares with the
 * bytes last exchanged (`localState`), and how the remote compares with them
 * (`remoteState`) — because that is what the blob-SHA model can prove without
 * guessing. The UI wants a single label, and the badge and the row's menu must never
 * disagree about which one it is, so the collapse happens exactly once, here.
 */
import type { TrackedCatalog } from "../api/catalogShare";

export type CatalogSyncStatus =
  /** Not tracked against any repository — a purely local catalogue. */
  | "localOnly"
  /** Local and remote both match the bytes last exchanged. */
  | "inSync"
  /** Edited locally since the last exchange; the repository has not moved. */
  | "localAhead"
  /** The repository has moved; the local copy has no edits of its own. */
  | "remoteAhead"
  /** Both sides moved. This is the only state that needs a decision. */
  | "diverged"
  /** Tracked, but the file is gone from the decoder directory. */
  | "missing"
  /** Tracked, but no update check has run, so the remote side is unknown. */
  | "unchecked";

export function catalogSyncStatus(source?: TrackedCatalog): CatalogSyncStatus {
  if (!source) return "localOnly";
  // A missing file outranks everything: there is nothing to compare, and every
  // action offered for it would fail.
  if (source.localState === "missing") return "missing";
  if (source.remoteState === "diverged") return "diverged";
  // The "never offer a one-click pull over local edits" rule is enforced in Rust —
  // `CatalogEntry::remote_state` already weighs the local state and returns Diverged
  // for that case, and `pull_catalog` refuses a second time before writing. Repeating
  // it here would be a lower-authority copy that masks a regression rather than
  // catching one.
  if (source.remoteState === "upstreamAhead") return "remoteAhead";
  if (source.localState === "modified") return "localAhead";
  // Nothing local to push and nothing known upstream. `unknown` means no check has
  // run yet, which is worth distinguishing from a checked, genuinely in-sync copy.
  return source.remoteState === "unknown" ? "unchecked" : "inSync";
}

/** Is there anything to send upstream? Drives whether Push is worth offering. */
export function hasLocalChanges(status: CatalogSyncStatus): boolean {
  return status === "localAhead" || status === "diverged";
}

/** Is there anything to take from upstream? */
export function hasRemoteChanges(status: CatalogSyncStatus): boolean {
  return status === "remoteAhead" || status === "diverged";
}
