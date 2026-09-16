// Page-size resolution, the option-value codec and the Auto row-count arithmetic.
//
// The DOM half of useAutoRowCount is not covered here — Vitest runs with
// `environment: "node"` and no jsdom, which is why the arithmetic is exported separately.

import { describe, it, expect } from "vitest";
import {
  DEFAULT_PAGE_SIZE,
  ALL_FALLBACK_ROWS,
  resolvePageSize,
  pageSizeToOptionValue,
  pageSizeFromOptionValue,
  pageCount,
  pageForOffset,
} from "../utils/pageSize";
import { computeAutoRows, shouldCommit } from "../hooks/useAutoRowCount";

describe("resolvePageSize", () => {
  it("passes a plain size through", () => {
    expect(resolvePageSize(50, 33)).toBe(50);
  });

  it("does not make a numeric setting wait on the fit", () => {
    expect(resolvePageSize(50, null)).toBe(50);
  });

  it("resolves auto to the measured row count", () => {
    expect(resolvePageSize("auto", 33)).toBe(33);
  });

  it("returns null until the fit is measured, so callers skip the fetch", () => {
    // The whole point: a view guards on null rather than fetching an arbitrary page at
    // mount and replacing it a frame later. The type makes forgetting a compile error.
    expect(resolvePageSize("auto", null)).toBeNull();
  });

  it("resolves all to the supplied total, or a bounded fallback", () => {
    expect(resolvePageSize("all", 33, 4812)).toBe(4812);
    expect(resolvePageSize("all", 33)).toBe(ALL_FALLBACK_ROWS);
  });

  it("never returns a negative or zero size for a numeric setting", () => {
    // The union rules out the modes, not a nonsense number from stale state.
    expect(resolvePageSize(0, 10)).toBe(DEFAULT_PAGE_SIZE);
    expect(resolvePageSize(-7, 10)).toBe(DEFAULT_PAGE_SIZE);
  });

  it("clamps a bogus all total rather than requesting zero rows", () => {
    expect(resolvePageSize("all", 10, 0)).toBe(1);
  });
});

describe("page-size option values", () => {
  it("round-trips every page size through a select's string value", () => {
    for (const size of ["auto", "all", 20, 100] as const) {
      expect(pageSizeFromOptionValue(pageSizeToOptionValue(size))).toBe(size);
    }
  });

  it("falls back rather than yielding a non-positive size", () => {
    // "-2" is a page-size sentinel from a previous build; it must not come back as -2.
    for (const raw of ["", "-1", "-2", "0", "abc"]) {
      expect(pageSizeFromOptionValue(raw)).toBe(DEFAULT_PAGE_SIZE);
    }
  });
});

describe("pageCount / pageForOffset", () => {
  it("counts and locates pages for a resolved size", () => {
    expect(pageCount(500, 20)).toBe(25);
    expect(pageCount(0, 20)).toBe(1);
    expect(pageForOffset(1234, 20)).toBe(61);
  });

  it("stays finite while the size is unresolved", () => {
    // Both used to divide by 0: the counter rendered "1 / Infinity" and the timeline
    // scrub called setCurrentPage(Infinity).
    expect(pageCount(500, null)).toBe(1);
    expect(pageForOffset(1234, null)).toBe(0);
  });

  it("never locates a negative page", () => {
    expect(pageForOffset(-1, 20)).toBe(0);
  });
});

describe("computeAutoRows", () => {
  const base = { headerPx: 29, reservedPx: 32, rowHeight: 24, minRows: 5, maxRows: 500 };

  it("fits rows into the space left after header and reserved chrome", () => {
    // 800 - 29 - 32 = 739 usable; 739 / 24 = 30.8 -> 30
    expect(computeAutoRows({ ...base, availPx: 800 })).toBe(30);
  });

  it("floors at minRows on a tiny container", () => {
    expect(computeAutoRows({ ...base, availPx: 70 })).toBe(base.minRows);
  });

  it("caps at maxRows on a very tall container", () => {
    expect(computeAutoRows({ ...base, availPx: 100_000 })).toBe(base.maxRows);
  });

  it("refuses to divide by an implausible row height", () => {
    // A zero here would produce Infinity rows and a catastrophic query.
    expect(computeAutoRows({ ...base, availPx: 800, rowHeight: 0 })).toBe(0);
  });
});

describe("shouldCommit", () => {
  it("commits the first measurement", () => {
    expect(shouldCommit(30, null, 739, 0, 24)).toBe(true);
  });

  it("ignores a recomputation that lands on the same count", () => {
    expect(shouldCommit(30, 30, 739, 735, 24)).toBe(false);
  });

  it("holds a count change that is within half a row of noise", () => {
    // Container resting on a row boundary: without this, sub-pixel drift flips the count
    // back and forth, and every flip is a refetch.
    expect(shouldCommit(31, 30, 745, 739, 24)).toBe(false);
  });

  it("commits once the height has genuinely moved", () => {
    expect(shouldCommit(34, 30, 835, 739, 24)).toBe(true);
  });
});
