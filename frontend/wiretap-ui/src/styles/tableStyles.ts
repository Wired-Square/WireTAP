// ui/src/styles/tableStyles.ts
//
// Shared metrics for the monospace data tables — the frame tables and the serial byte
// dump. They are read side by side (Raw Bytes and Framed Bytes are two tabs of one view),
// so their rows have to line up; keeping the padding here is what stops one drifting when
// the other is edited.

import { borderDataView, textMuted } from "./colourTokens";

/**
 * Scroll container for a data table. `min-h-0` lets it shrink inside a flex column and
 * scroll internally, rather than being clamped by an ancestor's `overflow-hidden`.
 */
export const dataTableContainer = "flex-1 min-h-0 overflow-auto font-mono text-xs";

/** Body cell. */
export const dataCell = "px-2 py-0.5";

/** Header cell, rule included — no caller has ever wanted one without the other. */
export const dataHeaderCell = `px-2 py-1.5 border-b ${borderDataView}`;

/**
 * The wider metrics used by the Modbus result tables, which are read as prose
 * rather than scanned as a byte dump — separate from `dataCell` above on
 * purpose, and shared because the two result views must not drift apart.
 */
export const resultHeaderCell = `text-left px-3 py-1.5 ${textMuted} font-medium`;
export const resultCell = (tone: string) => `px-3 py-1 ${tone} font-mono`;
