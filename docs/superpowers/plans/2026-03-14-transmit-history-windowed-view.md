# Transmit History — Windowed View Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the unbounded TransmitHistoryView with a windowed view that holds ~90 rows in state, reducing WebView memory growth from ~19 MB/min to negligible.

**Architecture:** New `useTransmitHistoryView` hook with two modes: live (throttled poll at top of scroll) and browse (fetch on scroll). Spacer `<tr>` elements inside `<tbody>` maintain scroll height without breaking sticky headers. All data stays in SQLite — frontend only holds the visible window.

**Tech Stack:** React hooks, Zustand (`transmitStore`), existing Tauri IPC (`transmitHistoryQuery`, `transmitHistoryCount`)

**Spec:** `docs/superpowers/specs/2026-03-14-transmit-history-windowed-view-design.md`

---

## File Map

| Action | File | Responsibility |
|--------|------|---------------|
| Create | `src/apps/transmit/hooks/useTransmitHistoryView.ts` | Windowed data hook — live/browse modes, spacer calculation, scroll handling |
| Modify | `src/apps/transmit/views/TransmitHistoryView.tsx` | Replace internal state with hook, add spacers, remove Load More |

No backend changes. No new API wrappers. No store changes.

---

### Task 1: Create `useTransmitHistoryView` hook

**Files:**
- Create: `src/apps/transmit/hooks/useTransmitHistoryView.ts`

This is the core of the change. The hook manages two modes (live and browse), scroll-driven fetching, spacer calculations, and generation-counter-based fetch deduplication.

- [ ] **Step 1: Create the hook file with types and skeleton**

```typescript
// src/apps/transmit/hooks/useTransmitHistoryView.ts
//
// Windowed view hook for transmit history.
// Two modes: live (poll newest rows at top) and browse (fetch on scroll).
// All data stays in SQLite — frontend holds only the visible window + overscan.

import { useState, useEffect, useRef, useCallback, type RefObject, type UIEventHandler } from "react";
import { useTransmitStore } from "../../../stores/transmitStore";
import {
  transmitHistoryQuery,
  transmitHistoryClear,
  type TransmitHistoryRow,
} from "../../../api/transmitHistory";

const DEFAULT_ROW_HEIGHT = 32;
const DEFAULT_OVERSCAN = 20;
const DEFAULT_POLL_INTERVAL_MS = 500;

interface UseTransmitHistoryViewOptions {
  containerRef: RefObject<HTMLDivElement | null>;
  rowHeight?: number;
  overscan?: number;
  pollIntervalMs?: number;
}

interface UseTransmitHistoryViewResult {
  rows: TransmitHistoryRow[];
  totalCount: number;
  isLive: boolean;
  isLoading: boolean;
  spacerTop: number;
  spacerBottom: number;
  onScroll: UIEventHandler<HTMLDivElement>;
  /** Reset state and clear SQLite history */
  clear: () => Promise<void>;
  /** The offset of the first row in `rows` within the full dataset */
  windowStart: number;
}

export function useTransmitHistoryView(
  options: UseTransmitHistoryViewOptions
): UseTransmitHistoryViewResult {
  const {
    containerRef,
    rowHeight = DEFAULT_ROW_HEIGHT,
    overscan = DEFAULT_OVERSCAN,
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  } = options;

  const historyDbCount = useTransmitStore((s) => s.historyDbCount);

  const [rows, setRows] = useState<TransmitHistoryRow[]>([]);
  const [windowStart, setWindowStart] = useState(0);
  const [isLive, setIsLive] = useState(true);
  const [isLoading, setIsLoading] = useState(false);

  // Generation counter for discarding stale fetches
  const generationRef = useRef(0);
  // RAF gate for scroll handler
  const rafPendingRef = useRef(false);
  // Track whether a browse fetch is in-flight
  const fetchInFlightRef = useRef(false);
  // Latest requested scroll offset (for deduplication)
  const pendingScrollOffsetRef = useRef<number | null>(null);

  // Refs for values read inside scroll handler to avoid stale closures
  const isLiveRef = useRef(isLive);
  const windowStartRef = useRef(windowStart);
  const rowsLengthRef = useRef(rows.length);
  useEffect(() => { isLiveRef.current = isLive; }, [isLive]);
  useEffect(() => { windowStartRef.current = windowStart; }, [windowStart]);
  useEffect(() => { rowsLengthRef.current = rows.length; }, [rows.length]);

  // Use historyDbCount as totalCount (updated by transmitHistorySubscription)
  const totalCount = historyDbCount;

  // --- Live mode polling ---
  useEffect(() => {
    if (!isLive) return;

    const gen = ++generationRef.current;

    const fetchNewest = async () => {
      if (generationRef.current !== gen) return;
      const container = containerRef.current;
      const containerHeight = container?.clientHeight ?? 400;
      const windowSize = Math.ceil(containerHeight / rowHeight) + overscan * 2;

      try {
        const result = await transmitHistoryQuery(0, windowSize);
        if (generationRef.current !== gen) return;
        setRows(result);
        setWindowStart(0);
      } catch {
        // Non-critical — next poll will retry
      }
    };

    // Immediate fetch on mount / entering live mode
    fetchNewest();

    const intervalId = setInterval(fetchNewest, pollIntervalMs);
    return () => clearInterval(intervalId);
  }, [isLive, containerRef, rowHeight, overscan, pollIntervalMs]);

  // --- Browse mode: fetch window on scroll ---
  // Uses getState() for totalCount to avoid recreating on every historyDbCount change
  const fetchWindow = useCallback(async (offset: number) => {
    const gen = generationRef.current;
    if (fetchInFlightRef.current) {
      pendingScrollOffsetRef.current = offset;
      return;
    }

    fetchInFlightRef.current = true;
    const container = containerRef.current;
    const containerHeight = container?.clientHeight ?? 400;
    const visibleCount = Math.ceil(containerHeight / rowHeight);
    const currentTotalCount = useTransmitStore.getState().historyDbCount;
    const fetchStart = Math.max(0, offset - overscan);
    const fetchEnd = Math.min(currentTotalCount, offset + visibleCount + overscan);
    const fetchLimit = fetchEnd - fetchStart;

    if (fetchLimit <= 0) {
      fetchInFlightRef.current = false;
      return;
    }

    setIsLoading(true);
    try {
      const result = await transmitHistoryQuery(fetchStart, fetchLimit);
      if (generationRef.current !== gen) {
        fetchInFlightRef.current = false;
        return;
      }
      setRows(result);
      setWindowStart(fetchStart);
    } catch {
      // Non-critical
    } finally {
      fetchInFlightRef.current = false;

      // If a newer scroll position was queued, fetch it now
      const pending = pendingScrollOffsetRef.current;
      if (pending !== null) {
        pendingScrollOffsetRef.current = null;
        // Defer to avoid isLoading flash — set loading false only when no pending
        fetchWindow(pending);
      } else {
        setIsLoading(false);
      }
    }
  }, [containerRef, rowHeight, overscan]);

  // --- Scroll handler ---
  // Uses refs for rapidly changing values to avoid stale closures and recreation churn
  const onScroll: UIEventHandler<HTMLDivElement> = useCallback(() => {
    if (rafPendingRef.current) return;
    rafPendingRef.current = true;

    requestAnimationFrame(() => {
      rafPendingRef.current = false;
      const el = containerRef.current;
      if (!el) return;
      const scrollTop = el.scrollTop;

      // Mode transition
      if (scrollTop < rowHeight) {
        if (!isLiveRef.current) setIsLive(true);
        return;
      }

      if (isLiveRef.current) setIsLive(false);

      // Calculate which rows should be visible
      const visibleStart = Math.floor(scrollTop / rowHeight);

      // Check if we need to fetch (scroll near edge of loaded window)
      const ws = windowStartRef.current;
      const loadedEnd = ws + rowsLengthRef.current;
      const needsFetch =
        visibleStart < ws + overscan ||
        visibleStart + Math.ceil(el.clientHeight / rowHeight) > loadedEnd - overscan;

      if (needsFetch) {
        fetchWindow(visibleStart);
      }
    });
  }, [containerRef, rowHeight, overscan, fetchWindow]);

  // --- Spacer calculations ---
  const spacerTop = windowStart * rowHeight;
  const spacerBottom = Math.max(0, (totalCount - windowStart - rows.length) * rowHeight);

  // --- Clear ---
  const clear = useCallback(async () => {
    generationRef.current++;
    await transmitHistoryClear();
    setRows([]);
    setWindowStart(0);
    setIsLive(true);
    useTransmitStore.setState({ historyDbCount: 0 });
  }, []);

  return {
    rows,
    totalCount,
    isLive,
    isLoading,
    spacerTop,
    spacerBottom,
    onScroll,
    clear,
    windowStart,
  };
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `cd /Users/garth/Library/CloudStorage/Dropbox/Development/WiredSquare/WireTAP && npx tsc --noEmit 2>&1 | head -20`
Expected: No errors related to `useTransmitHistoryView.ts`

- [ ] **Step 3: Commit**

```
feat(transmit): add useTransmitHistoryView windowed hook
```

---

### Task 2: Update `TransmitHistoryView` to use the hook

**Files:**
- Modify: `src/apps/transmit/views/TransmitHistoryView.tsx`

Replace internal state management with the new hook. Add spacer `<tr>` elements inside `<tbody>`. Remove Load More button. Remove `failedCount` from toolbar.

- [ ] **Step 1: Rewrite TransmitHistoryView**

Changes:
1. Add `const containerRef = useRef<HTMLDivElement>(null);`
2. Call `useTransmitHistoryView({ containerRef })` — destructure `rows`, `totalCount`, `isLive`, `isLoading`, `spacerTop`, `spacerBottom`, `onScroll`, `clear`, `windowStart`
3. Remove all old state: `fetchFirstPage`, `handleLoadMore`, `PAGE_SIZE`, `offset`, `hasMore`, `historyDbCount` selector
4. Replace `handleClear` with `clear` from the hook
5. Remove `failedCount` useMemo and its toolbar display
6. Remove `ChevronDown` import (Load More button gone)
7. Add local `isExporting` state for the export button (hook's `isLoading` is for window fetches)
8. Use `totalCount > 0` for the outer conditional (not `rows.length > 0`) to avoid flash during browse-mode fetches
9. `handleExport` uses `totalCount` and local `isExporting` state

Key structural change — spacers as `<tr>` inside `<tbody>` to avoid breaking the sticky `<thead>`:

```tsx
const containerRef = useRef<HTMLDivElement>(null);
const {
  rows, totalCount, isLive, isLoading, spacerTop, spacerBottom, onScroll, clear,
} = useTransmitHistoryView({ containerRef });
const [isExporting, setIsExporting] = useState(false);

// ...

<div
  ref={containerRef}
  className="flex-1 overflow-auto"
  onScroll={onScroll}
>
  <table className="w-full text-sm">
    <thead className={`${bgDataToolbar} sticky top-0 ${textDataSecondary} text-xs`}>
      <tr>
        <th className="text-left px-4 py-2 w-10"></th>
        <th className="text-left px-4 py-2">Timestamp</th>
        <th className="text-left px-4 py-2">Bus</th>
        <th className="text-left px-4 py-2 w-16">Kind</th>
        <th className="text-left px-4 py-2">Frame / Data</th>
        <th className="text-left px-4 py-2">Error</th>
      </tr>
    </thead>
    <tbody>
      {/* Top spacer — positions rows at correct scroll offset */}
      {spacerTop > 0 && (
        <tr><td colSpan={6} style={{ height: spacerTop, padding: 0, border: 'none' }} /></tr>
      )}

      {rows.map((row, index) => {
        const prevTimestampUs =
          index < rows.length - 1 ? rows[index + 1].timestamp_us : null;
        // ... existing row rendering unchanged ...
      })}

      {/* Bottom spacer — maintains total scroll height */}
      {spacerBottom > 0 && (
        <tr><td colSpan={6} style={{ height: spacerBottom, padding: 0, border: 'none' }} /></tr>
      )}
    </tbody>
  </table>
</div>
```

Toolbar changes:
```tsx
<span className={`${textDataSecondary} text-sm`}>
  {totalCount.toLocaleString()} packet{totalCount !== 1 ? "s" : ""}
  {!isLive && (
    <span className="text-amber-400 ml-2">(browsing)</span>
  )}
</span>
```

Export handler uses local `isExporting` state:
```tsx
const handleExport = useCallback(async () => {
  if (totalCount === 0) return;
  setIsExporting(true);
  try {
    const allRows = await transmitHistoryQuery(0, totalCount + 1);
    // ... existing CSV building code unchanged ...
  } finally {
    setIsExporting(false);
  }
}, [totalCount, formatTimestampString]);
```

**Note on delta-last timestamps:** At the bottom edge of the visible window, `prevTimestampUs` will be `null` (next row not loaded). This shows "0.000000s" — an acceptable artefact of windowing.

- [ ] **Step 2: Verify TypeScript compiles**

Run: `cd /Users/garth/Library/CloudStorage/Dropbox/Development/WiredSquare/WireTAP && npx tsc --noEmit 2>&1 | head -20`
Expected: No errors

- [ ] **Step 3: Verify the app builds and renders**

Run: `cd /Users/garth/Library/CloudStorage/Dropbox/Development/WiredSquare/WireTAP && npm run tauri dev`
Expected: App launches, Transmit tab loads, History tab shows empty state or existing history

- [ ] **Step 4: Commit**

```
feat(transmit): wire TransmitHistoryView to windowed hook
```

---

### Task 3: Smoke test (manual)

**Files:** None (manual testing)

- [ ] **Step 1: Test live mode**

1. Open Transmit app, switch to History tab
2. Set up Transmit with two Innomaker interfaces, start repeating frames
3. Verify: newest frames appear at top, table updates every ~500ms
4. Verify: toolbar shows total count, no failed count
5. Verify: scroll bar size reflects total history, not just visible rows

- [ ] **Step 2: Test browse mode**

1. While frames are transmitting, scroll down in history
2. Verify: table stops updating (browse mode)
3. Verify: toolbar shows "(browsing)" indicator
4. Verify: scrolling loads older rows seamlessly
5. Scroll back to top — verify live mode resumes

- [ ] **Step 3: Test clear**

1. Click Clear in toolbar
2. Verify: history clears, empty state shows
3. Verify: no stale rows flash after clear

- [ ] **Step 4: Test export**

1. Transmit some frames, click Export
2. Verify: CSV contains all rows, not just visible window

- [ ] **Step 5: Test memory**

1. Run Transmit with repeating frames for 10+ minutes
2. Monitor WebView memory in Activity Monitor
3. Verify: memory growth is significantly reduced compared to ~19 MB/min baseline

- [ ] **Step 6: Commit all changes if not already committed**
