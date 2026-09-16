// Page sizes shared by every paginated data view.
//
// Two types, because two different things were being carried in one number. A
// `PageSize` is what the rows-per-page control holds — a row count, or one of the
// non-numeric modes. A `ResolvedPageSize` is a concrete count ready to reach an
// offset or a limit, and `null` until the Auto fit has been measured.
//
// Keeping the modes as strings is the whole point: `total / pageSize` on an
// unresolved setting does not compile, and neither does arithmetic on a resolved
// size that has not been null-checked.

/**
 * What the rows-per-page control holds.
 *
 * `"all"` is not currently selectable — no options array offers it. It survives as the
 * "this view has no pager" value, and because `resolvePageSize` is already built for it
 * if it is ever offered as a real choice.
 */
export type PageSize = number | "auto" | "all";

/** A concrete row count, or `null` while an Auto fit has not been measured. */
export type ResolvedPageSize = number | null;

/** Rows per page when a view has no better answer. */
export const DEFAULT_PAGE_SIZE = 20;

/** Cap for `all` when the caller has no real total to offer. */
export const ALL_FALLBACK_ROWS = 1000;

/**
 * Turn a page-size setting into a concrete row count.
 *
 * Returns `null` until the Auto fit lands, so callers skip the fetch rather than
 * requesting an arbitrary page at mount and replacing it a frame later.
 */
export function resolvePageSize(
  setting: PageSize,
  autoRows: ResolvedPageSize,
  /** Real total for `all`; omit and it falls back to a bounded cap. */
  allRows?: number,
): ResolvedPageSize {
  if (setting === "auto") return autoRows;
  if (setting === "all") return Math.max(1, allRows ?? ALL_FALLBACK_ROWS);
  return setting > 0 ? setting : DEFAULT_PAGE_SIZE;
}

/** `<option>` value for a page size — a select's values are strings anyway. */
export const pageSizeToOptionValue = (size: PageSize): string => String(size);

/** Read an `<option>` value back. Total, and never yields a non-positive number. */
export function pageSizeFromOptionValue(raw: string): PageSize {
  if (raw === "auto" || raw === "all") return raw;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_PAGE_SIZE;
}

// Dividing by an unresolved size gives Infinity, and it reaches the page counter and
// `setCurrentPage`. Both divisions live here so no caller has to remember the guard.

/** Pages needed for `totalRows`, or 1 while the size is unresolved. */
export const pageCount = (totalRows: number, pageSize: ResolvedPageSize): number =>
  pageSize === null ? 1 : Math.max(1, Math.ceil(totalRows / pageSize));

/** The page an absolute row offset lands on, or 0 while the size is unresolved. */
export const pageForOffset = (offset: number, pageSize: ResolvedPageSize): number =>
  pageSize === null ? 0 : Math.floor(Math.max(0, offset) / pageSize);
