// src/apps/transmit/hooks/useTransmitHistoryView.ts
//
// Windowed view hook for transmit history.
// - Live: re-fetches the session's newest rows when its count changes
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
import { useSessionHistoryCount } from "./useSessionHistoryCount";
import {
  DEFAULT_PAGE_SIZE,
  pageCount,
  pageForOffset,
  type ResolvedPageSize,
} from "../../../utils/pageSize";

interface UseTransmitHistoryViewOptions {
  pageSize?: ResolvedPageSize;
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
  const totalCount = useSessionHistoryCount(sessionId);
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
    if (!sessionId || totalCount === 0) {
      setTimeRange(null);
      return;
    }
    let cancelled = false;
    transmitHistoryTimeRange(sessionId).then((range) => {
      if (cancelled || !range) return;
      setTimeRange({ startUs: range[0], endUs: range[1] });
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [sessionId, totalCount]);

  // --- Live mode: re-fetch when the session's count changes ---
  // The count follows the WS TransmitUpdated signal instead of blind polling,
  // eliminating the 500ms invoke round-trip that leaked WebKit networking objects.
  useEffect(() => {
    if (!isLive || !sessionId || pageSize === null) return;

    const gen = ++generationRef.current;
    const fetchNewest = async () => {
      setIsLoading(true);
      try {
        // Offset 0 with DESC ordering gives the newest rows
        const result = await transmitHistoryQuery(sessionId, 0, pageSize);
        if (generationRef.current !== gen) return;
        trackAlloc("transmitHistory.fetch", result.length * 500);
        setRows(result);
      } catch {
        // Non-critical
      } finally {
        if (generationRef.current === gen) setIsLoading(false);
      }
    };

    fetchNewest();
  }, [isLive, sessionId, pageSize, totalCount]);

  // --- Browse mode: fetch page on page change ---
  useEffect(() => {
    if (isLive || !sessionId || pageSize === null) return;

    const gen = generationRef.current;
    let cancelled = false;

    const fetchPage = async () => {
      setIsLoading(true);
      try {
        const offset = currentPage * pageSize;
        const result = await transmitHistoryQuery(sessionId, offset, pageSize);
        if (cancelled || generationRef.current !== gen) return;
        setRows(result);
      } catch {
        // Non-critical
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    };

    fetchPage();
    return () => { cancelled = true; };
  }, [isLive, sessionId, currentPage, pageSize]);

  // When entering live mode, reset to page 0
  useEffect(() => {
    if (isLive) setCurrentPage(0);
  }, [isLive]);

  // --- Navigate to timestamp (for timeline scrubber) ---
  const navigateToTimestamp = useCallback(async (timestampUs: number) => {
    if (!sessionId) return;
    setIsLive(false);
    try {
      const offset = await transmitHistoryFindOffset(sessionId, timestampUs);
      setCurrentPage(pageForOffset(offset, pageSize));
    } catch {
      // Non-critical
    }
  }, [sessionId, pageSize]);

  // --- Clear ---
  const clear = useCallback(async () => {
    if (!sessionId) return;
    const remaining = await transmitHistoryClear(sessionId);
    setRows([]);
    setCurrentPage(0);
    setTimeRange(null);
    setIsLive(true);
    useTransmitStore.setState({ historyDbCount: remaining });
  }, [sessionId]);

  const totalPages = pageCount(totalCount, pageSize);

  return {
    rows: sessionId ? rows : [],
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
