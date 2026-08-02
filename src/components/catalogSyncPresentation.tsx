// ui/src/components/catalogSyncPresentation.tsx
//
// How a catalogue's sync status is dressed, in one place.
//
// The status itself is computed in Rust (`catalog_share::registry::SyncStatus::collapse`)
// and arrives on every catalogue, so nothing here derives anything — this is purely
// "what does that word look like".
//
// Two shapes, one table (`SYNC_STATUS_DRESS` in `./catalogIcons`, beside the action
// vocabulary it must not collide with). The picker wants a glyph in a row that has no
// room for words; the settings list has room for both, and showing both is what
// teaches the picker's bare glyph. They are deliberately not merged into one
// component — a fast selector and a management surface are different jobs — but they
// cannot dress the same status differently.

import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import type { CatalogSyncStatus } from "../api/catalogShare";
import { iconMd, iconSm } from "../styles/spacing";
import { SYNC_STATUS_DRESS } from "./catalogIcons";

/**
 * The status as one glyph, for lists with no room for a word.
 *
 * `repoCount` names how many repositories the status was folded from — see
 * [useStatusLabel] for when it is said at all.
 */
export function CatalogSyncIcon({
  status,
  repoCount,
}: {
  status: CatalogSyncStatus;
  repoCount?: number;
}) {
  const label = useStatusLabel(status, repoCount);
  const { Icon, tone } = SYNC_STATUS_DRESS[status];
  // The tooltip and the accessible name sit on the wrapper, not the <svg>: `title` is
  // an HTML global attribute, whereas an SVG's tooltip comes from a <title> child, so
  // browsers do not reliably surface it from the attribute. A plain <span> also keeps
  // this legal and non-interactive inside the picker row's <button>.
  return (
    <span title={label} role="img" aria-label={label} className="flex-shrink-0">
      <Icon className={`${iconMd} ${tone}`} aria-hidden="true" />
    </span>
  );
}

/**
 * The status as a labelled pill, for lists with room to say it.
 *
 * Carries the glyph as well as the word, so the settings list is where a reader
 * learns what the picker's bare glyph means — nothing else on screen teaches that.
 */
export function CatalogSyncBadge({ status }: { status: CatalogSyncStatus }) {
  const label = useStatusLabel(status);
  const { Icon, badge } = SYNC_STATUS_DRESS[status];
  return (
    <span className={`${badge} inline-flex items-center gap-1`}>
      <Icon className={iconSm} aria-hidden="true" />
      {label}
    </span>
  );
}

/**
 * The one owner of what a status is called, and of the key path it lives at.
 *
 * Exported as a plain function as well as the hook below, because the push dialog
 * names statuses inside a native `<option>` — text only, so no badge, and inside a
 * `.map()`, so no hook. Reaching for the key directly there was the drift risk: a
 * renamed namespace would leave every badge right and that one select showing
 * `catalogSync.status.inSync`, in the surface where nothing else would look wrong.
 *
 * `repoCount` is appended only above one: a summary glyph that gives no sign it is
 * summarising is the dishonest part, whereas "1 repository" on every other row is
 * noise.
 */
export function syncStatusLabel(
  t: TFunction<"common">,
  status: CatalogSyncStatus,
  repoCount = 0,
): string {
  const label = t(`catalogSync.status.${status}`);
  return repoCount > 1 ? `${label} · ${t("catalogSync.repos", { count: repoCount })}` : label;
}

function useStatusLabel(status: CatalogSyncStatus, repoCount = 0): string {
  // `common`, not `settings`: this renders in a dialog five panels mount, so it must
  // not depend on how the settings panel happens to arrange its keys — that would be
  // a settings-local edit silently un-labelling every icon, and it fails as a raw key
  // rather than as a build error.
  const { t } = useTranslation("common");
  return syncStatusLabel(t, status, repoCount);
}
