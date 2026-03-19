# Transmit History — Windowed View

**Date:** 2026-03-14
**Status:** Draft
**Scope:** `TransmitHistoryView` component and new `useTransmitHistoryView` hook

## Problem

The current `TransmitHistoryView` fetches 200 rows from SQLite on every `transmit-history-updated` event (fires per transmitted frame). At 2 frames/sec this creates ~400 JSON objects/sec plus full DOM reconciliation of 200 `<tr>` elements twice per second. WKWebView's JavaScriptCore does not return freed heap pages to the OS, so the process memory high-water mark grows continuously — observed at ~19 MB/min, reaching 1.88 GB in under an hour.

## Solution

Replace the flat fetch-all approach with a windowed view backed by the existing SQLite `transmitHistoryQuery(offset, limit)` API. The frontend holds only the visible rows plus a small overscan buffer (~90 rows total). All historical data stays in SQLite.

## Design

### New hook: `useTransmitHistoryView`

Located at `src/apps/transmit/hooks/useTransmitHistoryView.ts`.

**Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `containerRef` | `RefObject<HTMLDivElement>` | Scrollable container element |
| `rowHeight` | `number` | Estimated row height in px (default: 32) |
| `overscan` | `number` | Extra rows to fetch either side of viewport (default: 20) |
| `pollIntervalMs` | `number` | Live mode poll interval (default: 500) |

**Return value:**

| Field | Type | Description |
|-------|------|-------------|
| `rows` | `TransmitHistoryRow[]` | Rows to render (visible window + overscan) |
| `totalCount` | `number` | Total rows in SQLite (for toolbar display) |
| `isLive` | `boolean` | Whether in live (auto-updating) mode |
| `isLoading` | `boolean` | Whether a fetch is in progress |
| `spacerTop` | `number` | Top spacer height in px (for scroll positioning) |
| `spacerBottom` | `number` | Bottom spacer height in px (for scroll positioning) |
| `onScroll` | `UIEventHandler` | Scroll handler to attach to container |

### Data ordering

Rows are newest-first (backend returns `ORDER BY id DESC`). Row 0 in the scroll container is the newest row. Scrolling **down** moves toward **older** rows (higher offsets). All spacer maths and offset calculations depend on this ordering.

### Two modes

**Live mode** (scroll position at top, `scrollTop < rowHeight`):
- Polls `transmitHistoryQuery(0, windowSize)` at the configured interval (default 500ms).
- Each poll replaces state — always shows the newest rows.
- Exits live mode when `scrollTop >= rowHeight` (i.e. the user has scrolled past the first row).

**Browse mode** (`scrollTop >= rowHeight`):
- No polling — data is static.
- When scroll position nears the edge of loaded rows (within overscan distance), fetches the adjacent page from SQLite.
- Uses spacer `<div>` elements above and below the rendered rows to maintain correct scroll height (`totalCount * rowHeight`).
- Returns to live mode when `scrollTop < rowHeight`.

### Browse mode windowing

The hook maintains a sliding window of rows. On each scroll event (throttled via `requestAnimationFrame`):

```
visibleStart = floor(scrollTop / rowHeight)
visibleEnd   = visibleStart + ceil(containerHeight / rowHeight)
fetchStart   = max(0, visibleStart - overscan)
fetchEnd     = min(totalCount, visibleEnd + overscan)
```

The hook fetches `transmitHistoryQuery(fetchStart, fetchEnd - fetchStart)` and replaces state. Only one fetch is in-flight at a time — if a new scroll position arrives while a fetch is pending, the pending result is discarded via a generation counter and a new fetch is issued for the latest position.

### Scroll positioning with spacers

The scrollable container contains:
1. A top spacer div (`height: spacerTop`)
2. The rendered `<tr>` rows (only the visible window + overscan)
3. A bottom spacer div (`height: spacerBottom`)

The total scroll height is `totalCount * rowHeight`. As the user scrolls, the hook calculates which slice of rows to fetch based on `scrollTop` and the container height. Spacer heights adjust so the rows appear at the correct scroll position.

### Event handling

The `transmit-history-updated` Tauri event (fired per transmitted frame):
- **Always:** Updates `totalCount` via `transmitHistoryCount()` (lightweight integer, for toolbar display).
- **Live mode:** No additional action — the poll timer already fetches the latest rows.
- **Browse mode:** No data fetch — user is reading old data. Only the toolbar count updates.

This decouples the count update from row fetching entirely. The toolbar count may briefly show a higher number than displayed rows — this is acceptable since the poll catches up within 500ms.

### Timestamp formatting

The current `delta-start` mode uses the oldest row in the view as the baseline. In the windowed view, this becomes the oldest row in the **visible window**, not the entire history. This is acceptable — delta-start is relative to what you can see. If absolute-start semantics are needed later, the backend can supply the oldest timestamp.

### `failedCount` display

The current toolbar shows failed count from loaded rows. In the windowed view, this only reflects the visible window. The count display should be removed from the toolbar (or shown only when failures are visible) rather than showing a misleading partial count.

### Row height

The hook uses a fixed `rowHeight` estimate (default 32px). Actual rows may vary due to error messages or content. Scroll position may drift slightly — this is an acceptable trade-off for the initial implementation. A variable-height virtual list can be introduced later if needed.

### `TransmitHistoryView` component changes

- Receives data from `useTransmitHistoryView` instead of managing its own state.
- Removes `fetchFirstPage`, `handleLoadMore`, `PAGE_SIZE`, `offset`, `hasMore` state.
- Removes the "Load more" button.
- Toolbar count uses `totalCount` from the hook.
- Export button still fetches all rows on demand (one-shot query, not held in state).
- Clear button resets the hook state and calls `transmitHistoryClear()`. A generation counter ensures any in-flight fetches from before the clear are discarded.
- On mount (e.g. switching to History tab), the hook performs an initial fetch immediately rather than waiting for the first poll tick.

### Memory budget

- ~50 visible rows + 20 overscan each side = ~90 `TransmitHistoryRow` objects in state.
- Each row is ~200-300 bytes (id, session_id, timestamp, bytes array, flags).
- Total: ~27 KB — negligible compared to the current 200-row refetch churn.

## What this does NOT change

- **Backend:** No Rust changes. The existing `transmitHistoryQuery(offset, limit)` and `transmitHistoryCount()` APIs are sufficient.
- **SQLite schema:** No changes.
- **Transmit store:** `historyDbCount` subscription and event handling remain. The hook reads `historyDbCount` for its `totalCount` rather than fetching separately (optimisation).
- **Export:** Still fetches all rows on demand — acceptable since it's a one-shot user action.
- **Discovery:** Out of scope. Discovery's streaming frame display has different requirements (frame discovery, pattern detection) and will be addressed separately.

## Future considerations

- **Filtering:** The hook accepts offset/limit — adding filter parameters (bus, kind, success) is a straightforward extension to both the hook and the backend query.
- **Discovery migration:** The same windowed pattern could replace Discovery's 100k in-memory `_frameBuffer` during streaming, though Discovery needs a larger effective window for frame discovery purposes.
