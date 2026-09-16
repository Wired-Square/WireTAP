// Column arithmetic for the frame table. See FrameDataTable's <colgroup> comment for
// why ASCII shares the Data cell and why the Time column is sized per format.

import { describe, it, expect } from "vitest";
import { hexRunChars } from "../utils/byteUtils";
import { TIME_COLUMN_CHARS, formatIsoUs, formatHumanUs } from "../utils/timeFormat";

/** Rows as the table sees them — only `bytes` matters for width. */
const rows = (...lengths: number[]) => lengths.map((n) => ({ bytes: Array(n).fill(0) }));

describe("hex run width", () => {
  it("counts two characters per byte with single spaces between", () => {
    expect(hexRunChars(rows(1))).toBe(2);    // "FC"
    expect(hexRunChars(rows(2))).toBe(5);    // "FC FD"
    expect(hexRunChars(rows(16))).toBe(47);
    expect(hexRunChars(rows(20))).toBe(59);
  });

  it("takes the widest row on the page, so short rows pad out to it", () => {
    // The mixed 1/16/20-byte page that made the gutter ragged.
    expect(hexRunChars(rows(1, 16, 20, 1, 16))).toBe(59);
  });

  it("is zero when there is nothing to align", () => {
    expect(hexRunChars([])).toBe(0);
    expect(hexRunChars(rows(0))).toBe(0);
  });

  it("ignores byte values — width is a function of length alone", () => {
    expect(hexRunChars([{ bytes: [0x00, 0xff] }])).toBe(hexRunChars(rows(2)));
  });
});

describe("time column width", () => {
  // A timestamp well past year 2000, so both formatters emit their long date-bearing form.
  const ts = Date.UTC(2026, 7, 15, 21, 47, 3) * 1000 + 123_456;

  it("fits the ISO format it is sized for", () => {
    expect(TIME_COLUMN_CHARS.timestamp).toBeGreaterThanOrEqual(formatIsoUs(ts).length);
    expect(TIME_COLUMN_CHARS.timestamp).toBeGreaterThanOrEqual(formatIsoUs(ts, true).length);
  });

  it("fits the human format it is sized for", () => {
    expect(TIME_COLUMN_CHARS.human).toBeGreaterThanOrEqual(formatHumanUs(ts).length);
    expect(TIME_COLUMN_CHARS.human).toBeGreaterThanOrEqual(formatHumanUs(ts, true).length);
  });

  // The gap this sizing exists to close: a delta needs nowhere near an ISO timestamp, and
  // a column sized for the latter pushes every column after it away.
  it("gives a delta far less room than a timestamp", () => {
    expect(TIME_COLUMN_CHARS["delta-last"]).toBe(TIME_COLUMN_CHARS["delta-start"]);
    expect(TIME_COLUMN_CHARS["delta-last"]).toBeLessThan(TIME_COLUMN_CHARS.timestamp * 0.7);
  });
});
