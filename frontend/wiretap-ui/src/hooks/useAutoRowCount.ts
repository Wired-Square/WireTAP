// ui/src/hooks/useAutoRowCount.ts
//
// "How many rows fit in this scroll container?" — the measurement behind the Auto
// rows-per-page option.
//
// Only the scroll container is observed. That single element already reflects every
// input we care about: the Dockview panel being resized, the window being resized, and
// each chrome row (toolbar, timeline, find bar) appearing or disappearing above it. So
// there is nothing to enumerate and nothing to keep in sync when the chrome changes.

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

export interface AutoRowCountOptions {
  /** The `overflow-auto` element the rows live in. Must be an object ref. */
  containerRef: React.RefObject<HTMLElement | null>;
  /** When false the hook parks — no observer, no measuring, no state churn. */
  enabled: boolean;
  /** Selector for a rendered row, used to measure real row height. */
  rowSelector: string;
  /** Selector for in-container chrome that isn't a row (a sticky header). */
  headerSelector?: string | null;
  /** Fixed pixels inside the container that rows can never occupy (trailing spacers). */
  reservedPx?: number;
  /** Row height to assume before any row has rendered. */
  fallbackRowHeight?: number;
  minRows?: number;
  maxRows?: number;
  settleMs?: number;
}

export interface AutoRowCount {
  /** Rows that fit, or `null` before there is an answer — callers must not fetch on null. */
  rows: number | null;
  /**
   * True once a real *row* has been measured, rather than `fallbackRowHeight`.
   *
   * Not the same question as `rows !== null`: the first pass commits a fit derived
   * from the assumed row height, so a non-null `rows` with `isMeasured` false is the
   * normal state until real rows have rendered.
   */
  isMeasured: boolean;
  /**
   * Re-measure after the rows change — that is what replaces the assumed row height with
   * a real one. Stable identity. Debounced, so calling it from a render-frequency effect
   * is safe, but prefer to stop calling it once `isMeasured` is true.
   */
  remeasure: () => void;
}

/** Below this the container is hidden or collapsed, not genuinely tiny. */
const MIN_CREDIBLE_HEIGHT = 40;
/** Below this a measured row height is implausible; treat it as noise. */
const MIN_CREDIBLE_ROW_HEIGHT = 8;

/**
 * Rows that fit in `availPx`, clamped.
 *
 * Exported for tests — the DOM plumbing around it is not unit-testable here (Vitest
 * runs `environment: "node"` with no jsdom), so the arithmetic is kept separable.
 */
export function computeAutoRows(m: {
  availPx: number;
  headerPx: number;
  reservedPx: number;
  rowHeight: number;
  minRows: number;
  maxRows: number;
}): number {
  if (m.rowHeight < MIN_CREDIBLE_ROW_HEIGHT) return 0;
  const usable = m.availPx - m.headerPx - m.reservedPx;
  if (usable <= 0) return m.minRows;
  return Math.max(m.minRows, Math.min(m.maxRows, Math.floor(usable / m.rowHeight)));
}

/**
 * Whether a newly measured fit is worth committing.
 *
 * A changed row count is necessary but not sufficient: a container sitting exactly on a
 * row boundary would otherwise flip back and forth on sub-pixel noise, and each flip is
 * a backend refetch. Requiring the usable height to have moved by half a row makes the
 * change unambiguous.
 */
export function shouldCommit(
  next: number,
  committed: number | null,
  usablePx: number,
  committedUsablePx: number,
  rowHeight: number,
): boolean {
  if (next === committed) return false;
  if (committed === null) return true; // first measurement
  return Math.abs(usablePx - committedUsablePx) >= Math.max(8, rowHeight / 2);
}

export function useAutoRowCount({
  containerRef,
  enabled,
  rowSelector,
  headerSelector = null,
  reservedPx = 0,
  fallbackRowHeight = 24,
  minRows = 5,
  maxRows = 500,
  settleMs = 150,
}: AutoRowCountOptions): AutoRowCount {
  const [state, setState] = useState<{ rows: number | null; isMeasured: boolean }>({
    rows: null,
    isMeasured: false,
  });

  // Everything `measure` reads lives in refs, so `measure` — and therefore `schedule` and
  // `remeasure` — keep a stable identity and the ResizeObserver is built once. When these
  // were state deps, committing a row height tore the observer down and rebuilt it, and
  // the rebuild's cleanup cancelled the very work the commit had just scheduled.
  const committedRef = useRef<{
    rows: number | null;
    usablePx: number;
    rowHeight: number;
    isMeasured: boolean;
  }>({ rows: null, usablePx: 0, rowHeight: fallbackRowHeight, isMeasured: false });
  // Height reported by the observer. ResizeObserver delivers post-layout, so reading it
  // costs nothing, whereas `clientHeight` forces a style+layout flush.
  const observedHeightRef = useRef(0);
  const optsRef = useRef({ rowSelector, headerSelector, reservedPx, minRows, maxRows });
  optsRef.current = { rowSelector, headerSelector, reservedPx, minRows, maxRows };

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const rafRef = useRef<number | null>(null);

  const measure = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const { rowSelector, headerSelector, reservedPx, minRows, maxRows } = optsRef.current;

    // Prefer the observed height; fall back to a forced read only before the first
    // observer callback (the layout-effect first run).
    const availPx = observedHeightRef.current || el.clientHeight;
    // Hidden panel or an unmounted tab — keep the last good answer rather than
    // collapsing to the minimum and refetching when it comes back.
    if (availPx < MIN_CREDIBLE_HEIGHT) return;

    const headerPx = headerSelector
      ? (el.querySelector(headerSelector)?.getBoundingClientRect().height ?? 0)
      : 0;

    const committed = committedRef.current;
    let { rowHeight, isMeasured } = committed;

    const rowEls = el.querySelectorAll(rowSelector);
    if (rowEls.length > 0) {
      // Span of all rows divided by their count: two rects rather than one per row, and
      // it averages in any rows that wrapped, which is what stops the fit overshooting on
      // a narrow panel where payloads run onto a second line.
      const first = rowEls[0].getBoundingClientRect();
      const last = rowEls[rowEls.length - 1].getBoundingClientRect();
      const measured = (last.bottom - first.top) / rowEls.length;
      if (measured >= MIN_CREDIBLE_ROW_HEIGHT) {
        // Ignore sub-pixel drift, which would otherwise refit on every render.
        rowHeight = Math.abs(measured - rowHeight) < 1 ? rowHeight : measured;
        isMeasured = true;
      }
    }

    const usablePx = availPx - headerPx - reservedPx;
    const next = computeAutoRows({ availPx, headerPx, reservedPx, rowHeight, minRows, maxRows });
    if (next === 0) return;

    const commit = shouldCommit(next, committed.rows, usablePx, committed.usablePx, rowHeight);
    committedRef.current = { rows: commit ? next : committed.rows, usablePx, rowHeight, isMeasured };

    // Bail out of the update when nothing a consumer can see has changed.
    setState((prev) =>
      prev.rows === committedRef.current.rows && prev.isMeasured === isMeasured
        ? prev
        : { rows: committedRef.current.rows, isMeasured },
    );
  }, [containerRef]);

  const schedule = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = null;
        measure();
      });
    }, settleMs);
  }, [measure, settleMs]);

  // First measurement runs before paint, so the initial null-rows render is never shown.
  useLayoutEffect(() => {
    if (enabled) measure();
  }, [enabled, measure]);

  useEffect(() => {
    if (!enabled) return;
    const el = containerRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) {
        // borderBoxSize matches clientHeight's box; contentRect is the older fallback.
        observedHeightRef.current = entry.borderBoxSize?.[0]?.blockSize ?? entry.contentRect.height;
      }
      schedule();
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [enabled, containerRef, schedule]);

  // Pending work is cancelled only on unmount, so an option change can never drop a
  // measurement that is already in flight.
  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
  }, []);

  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const remeasure = useCallback(() => {
    if (enabledRef.current) schedule();
  }, [schedule]);

  return { ...state, remeasure };
}
