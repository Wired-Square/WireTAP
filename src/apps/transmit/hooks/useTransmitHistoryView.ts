// src/apps/transmit/hooks/useTransmitHistoryView.ts
//
// Windowed view hook for transmit history.
// - Live: re-fetches newest rows when historyDbCount changes
//   (driven by WS TransmitUpdated, no polling)
// - Browse: page controls (offset/limit pagination)
// All data stays in SQLite — frontend holds only one page of rows.

import { useState, useEffect, useRef, useCallback } from "react";
import { useTransmitStore } from "../../../stores/transmitStore";
import {
  transmitHistoryQuery,
  transmitHistoryClear,
  transmitHistoryTimeRange,
  transmitHistoryFindOffset,
  type TransmitHistoryRow,
} from "../../../api/transmitHistory";
import { trackAlloc } from "../../../services/memoryDiag";

const DEFAULT_PAGE_SIZE = 20;

interface UseTransmitHistoryViewOptions {
  pageSize?: number;
  sessionId?: string | null;
}

interface UseTransmitHistoryViewResult {
  rows: TransmitHistoryRow[];
  totalCount: number;
  isLive: boolean;
  isLoading: boolean;
  currentPage: number;
  totalPages: number;
  setCurrentPage: (page: number) => void;
  setIsLive: (live: boolean) => void;
  clear: () => Promise<void>;
  timeRange: { startUs: number; endUs: number } | null;
  navigateToTimestamp: (timestampUs: number) => Promise<void>;
}

export function useTransmitHistoryView(
  options?: UseTransmitHistoryViewOptions
): UseTransmitHistoryViewResult {
  const {
    pageSize = DEFAULT_PAGE_SIZE,
    sessionId,
  } = options ?? {};

  const [rows, setRows] = useState<TransmitHistoryRow[]>([]);
  const [isLive, setIsLive] = useState(true);
  const [isLoading, setIsLoading] = useState(false);
  const [currentPage, setCurrentPage] = useState(0);
  const [totalCount, setTotalCount] = useState(0);
  const [timeRange, setTimeRange] = useState<{ startUs: number; endUs: number } | null>(null);

  // Generation counter for discarding stale fetches
  const generationRef = useRef(0);

  // --- Reset to live when sessionId changes (Part 4) ---
  const prevSessionIdRef = useRef(sessionId);
  useEffect(() => {
    if (sessionId !== prevSessionIdRef.current) {
      prevSessionIdRef.current = sessionId;
      setIsLive(true);
    }
  }, [sessionId]);

  // --- Fetch time range when totalCount changes ---
  useEffect(() => {
    if (totalCount === 0) {
      setTimeRange(null);
      return;
    }
    let cancelled = false;
    transmitHistoryTimeRange().then((range) => {
      if (cancelled || !range) return;
      setTimeRange({ startUs: range[0], endUs: range[1] });
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [totalCount]);

  // --- Live mode: re-fetch when historyDbCount changes ---
  // The WS TransmitUpdated message updates historyDbCount in the store.
  // We subscribe to that value instead of blind polling, eliminating
  // the 500ms invoke round-trip that leaked WebKit networking objects.
  useEffect(() => {
    if (!isLive) return;

    const fetchNewest = async () => {
      const count = useTransmitStore.getState().historyDbCount;
      const gen = ++generationRef.current;
      setIsLoading(true);
      try {
        // Offset 0 with DESC ordering gives the newest rows
        const result = await transmitHistoryQuery(0, pageSize);
        if (generationRef.current !== gen) return;
        trackAlloc("transmitHistory.fetch", result.length * 500);
        setRows(result);
        setTotalCount(count);
      } catch {
        // Non-critical
      } finally {
        if (generationRef.current === gen) setIsLoading(false);
      }
    };

    fetchNewest();

    return useTransmitStore.subscribe(
      (state, prevState) => {
        if (state.historyDbCount !== prevState.historyDbCount) {
          fetchNewest();
        }
      }
    );
  }, [isLive, pageSize]);

  // --- Browse mode: fetch page on page change ---
  useEffect(() => {
    if (isLive) return;

    const gen = generationRef.current;
    let cancelled = false;

    const fetchPage = async () => {
      setIsLoading(true);
      try {
        const offset = currentPage * pageSize;
        const result = await transmitHistoryQuery(offset, pageSize);
        if (cancelled || generationRef.current !== gen) return;
        setRows(result);
        setTotalCount(useTransmitStore.getState().historyDbCount);
      } catch {
        // Non-critical
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    };

    fetchPage();
    return () => { cancelled = true; };
  }, [isLive, currentPage, pageSize]);

  // When entering live mode, reset to page 0
  useEffect(() => {
    if (isLive) setCurrentPage(0);
  }, [isLive]);

  // --- Navigate to timestamp (for timeline scrubber) ---
  const navigateToTimestamp = useCallback(async (timestampUs: number) => {
    setIsLive(false);
    try {
      const offset = await transmitHistoryFindOffset(timestampUs);
      const page = Math.floor(offset / pageSize);
      setCurrentPage(page);
    } catch {
      // Non-critical
    }
  }, [pageSize]);

  // --- Clear ---
  const clear = useCallback(async () => {
    await transmitHistoryClear();
    setRows([]);
    setCurrentPage(0);
    setTotalCount(0);
    setTimeRange(null);
    useTransmitStore.setState({ historyDbCount: 0 });
    // Force the live subscription effect to restart by toggling isLive.
    // Direct setIsLive(true) is a no-op if already true (React skips identical state).
    // The generationRef increment invalidates the existing subscription's fetches.
    setIsLive(false);
    // Use microtask to ensure React processes the false→true transition
    queueMicrotask(() => setIsLive(true));
  }, []);

  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));

  return {
    rows,
    totalCount,
    isLive,
    isLoading,
    currentPage,
    totalPages,
    setCurrentPage,
    setIsLive,
    clear,
    timeRange,
    navigateToTimestamp,
  };
}
