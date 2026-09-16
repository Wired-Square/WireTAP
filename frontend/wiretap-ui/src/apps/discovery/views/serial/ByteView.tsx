// ui/src/apps/discovery/views/serial/ByteView.tsx
//
// Scrolling hex dump display for raw serial bytes with timestamps.
// Supports backend buffer pagination for large captures.

import { useEffect, useRef, useMemo, useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import type { SerialBytesEntry, RawBytesViewConfig } from '../../../../stores/discoveryStore';
import { useDiscoverySerialStore } from '../../../../stores/discoverySerialStore';
import { useDiscoveryUIStore } from '../../../../stores/discoveryUIStore';
import { getCaptureBytesPaginated, getCaptureMetadataById, findCaptureBytesOffsetForTimestamp, type TimestampedByte } from '../../../../api/capture';
import { getCaptureBytesTail } from '../../../../api/io';
import { byteToHex, byteToAscii } from '../../../../utils/byteUtils';
import { pageCount, pageForOffset, type PageSize } from '../../../../utils/pageSize';
import { formatHumanUs, formatIsoUs, renderDeltaNode } from '../../../../utils/timeFormat';
import { PaginationToolbar, TimelineSection, BYTE_PAGE_SIZE_OPTIONS } from '../../components';
import { dataTableContainer, dataCell, dataHeaderCell } from '../../../../styles/tableStyles';
import {
  bgDataView,
  textDataSecondary,
  textDataTertiary,
  hoverDataRow,
  textDataGreen,
  textDataYellow,
  textDataCyan,
} from '../../../../styles';

interface ByteViewProps {
  viewConfig: RawBytesViewConfig;
  autoScroll?: boolean;
  displayTimeFormat?: 'delta-last' | 'delta-start' | 'timestamp' | 'human';
  /** Whether we're currently streaming data */
  isStreaming?: boolean;
  /** The session's byte capture and its total, as Rust pushes them (ByteCounts 0x19). */
  bytesCaptureId: string | null;
  byteCount: number;
}

/** Chunk bytes by time gap - bytes within gapUs of each other are grouped */
interface ByteChunk {
  bytes: number[];
  timestampUs: number; // Timestamp of first byte in chunk
  bus?: number; // Bus of first byte in chunk
}

function chunkBytesByGap(entries: SerialBytesEntry[], gapUs: number): ByteChunk[] {
  const chunks: ByteChunk[] = [];
  let currentChunk: ByteChunk | null = null;
  let lastTimestamp = 0;

  for (const entry of entries) {
    if (currentChunk === null) {
      // Start first chunk
      currentChunk = { bytes: [entry.byte], timestampUs: entry.timestampUs, bus: entry.bus };
      lastTimestamp = entry.timestampUs;
    } else if (entry.timestampUs - lastTimestamp <= gapUs) {
      // Within gap threshold, add to current chunk
      currentChunk.bytes.push(entry.byte);
      lastTimestamp = entry.timestampUs;
    } else {
      // Gap exceeded, start new chunk
      chunks.push(currentChunk);
      currentChunk = { bytes: [entry.byte], timestampUs: entry.timestampUs, bus: entry.bus };
      lastTimestamp = entry.timestampUs;
    }
  }

  // Push final chunk
  if (currentChunk !== null) {
    chunks.push(currentChunk);
  }

  return chunks;
}

export default function ByteView({ viewConfig, autoScroll = true, displayTimeFormat = 'human', isStreaming = false, bytesCaptureId, byteCount }: ByteViewProps) {
  const { t } = useTranslation("discovery");
  const containerRef = useRef<HTMLDivElement>(null);
  const wasAtBottom = useRef(true);

  // Column visibility from UI store (shared with CAN views)
  const showBusColumn = useDiscoveryUIStore((s) => s.showBusColumn);
  const showAsciiColumn = useDiscoveryUIStore((s) => s.showAsciiColumn);

  const rawBytesPageSize = useDiscoverySerialStore((s) => s.rawBytesPageSize);
  const setRawBytesPageSize = useDiscoverySerialStore((s) => s.setRawBytesPageSize);

  // Local pagination state (only used when not streaming)
  const [currentPage, setCurrentPage] = useState(0);
  const [backendBytes, setBackendBytes] = useState<SerialBytesEntry[]>([]);
  const [isLoadingPage, setIsLoadingPage] = useState(false);

  // Time range for timeline scrubber (from buffer metadata)
  const [timeRange, setTimeRange] = useState<{ min: number; max: number } | null>(null);

  // Every byte lives in the capture, so this is simply whether there is anything to show.
  const hasBytes = byteCount > 0;

  const pageSize = rawBytesPageSize;
  const totalPages = pageCount(byteCount, pageSize);

  // When streaming stops, jump to the last page
  const prevIsStreamingRef = useRef(isStreaming);
  useEffect(() => {
    if (prevIsStreamingRef.current && !isStreaming && hasBytes) {
      // Streaming just stopped - jump to last page
      setCurrentPage(Math.max(0, totalPages - 1));
    }
    prevIsStreamingRef.current = isStreaming;
  }, [isStreaming, hasBytes, totalPages]);

  // Clamp current page when total pages decreases (but only when not streaming)
  useEffect(() => {
    if (!isStreaming && currentPage >= totalPages) {
      setCurrentPage(Math.max(0, totalPages - 1));
    }
  }, [isStreaming, currentPage, totalPages]);

  // Fetch capture metadata for the timeline's time range. The timeline is hidden while
  // streaming, so only refresh once the stream stops rather than on every count push.
  useEffect(() => {
    if (!hasBytes) { setTimeRange(null); return; }
    if (!bytesCaptureId || isStreaming) return;

    const fetchMetadata = async () => {
      try {
        const metadata = await getCaptureMetadataById(bytesCaptureId);
        if (metadata && metadata.start_time_us !== null && metadata.end_time_us !== null) {
          setTimeRange({ min: metadata.start_time_us, max: metadata.end_time_us });
        }
      } catch (error) {
        console.error('Failed to fetch capture metadata:', error);
      }
    };

    fetchMetadata();
  }, [hasBytes, bytesCaptureId, isStreaming, byteCount]);

  // Rows always come from the byte capture — live tail and a stopped page are the same
  // query at different offsets. Rust writes bytes before it signals and owns the count it
  // pushes, so refetching whenever that count moves keeps this in step with the backend at
  // the backend's own 2 Hz throttle, with no timer here.
  //
  // The count reaches the fetch through a ref rather than the dependency array on purpose:
  // in the deps it would tear down and rebuild this effect twice a second, so the
  // coalescing flags below would reset each time and never actually coalesce anything.
  const refetchRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    if (!hasBytes || !bytesCaptureId) {
      setBackendBytes([]);
      return;
    }

    let isMounted = true;
    // A fetch can outlast the 500ms signal interval on a large capture. Skip while one is
    // in flight and run once more on completion, so fetches neither queue up on the DB
    // mutex nor land out of order.
    let inFlight = false;
    let missed = false;

    const fetchBytes = async () => {
      if (inFlight) { missed = true; return; }
      inFlight = true;
      setIsLoadingPage(true);

      try {
        const bytes = isStreaming
          ? (await getCaptureBytesTail(bytesCaptureId, pageSize)).bytes
          : (await getCaptureBytesPaginated(bytesCaptureId, currentPage * pageSize, pageSize)).bytes;
        if (!isMounted) return;

        setBackendBytes(bytes.map((b: TimestampedByte) => ({
          byte: b.byte,
          timestampUs: b.timestamp_us,
          bus: b.bus,
        })));
      } catch (error) {
        if (!isMounted) return;
        console.error('Failed to fetch bytes from capture:', error);
        setBackendBytes([]);
      } finally {
        inFlight = false;
        setIsLoadingPage(false);
        if (missed && isMounted) { missed = false; void fetchBytes(); }
      }
    };

    void fetchBytes();
    refetchRef.current = () => void fetchBytes();
    return () => {
      isMounted = false;
      refetchRef.current = null;
    };
  }, [hasBytes, bytesCaptureId, isStreaming, currentPage, pageSize]);

  const prevByteCountRef = useRef(byteCount);
  useEffect(() => {
    if (byteCount === prevByteCountRef.current) return;
    prevByteCountRef.current = byteCount;
    refetchRef.current?.();
  }, [byteCount]);

  const displayEntries = backendBytes;

  // Get first entry timestamp for delta-start reference
  const startTimeUs = displayEntries.length > 0 ? displayEntries[0].timestampUs : 0;

  // Format time based on settings - returns ReactNode for delta formats
  const formatTime = useCallback((timestampUs: number, prevTimestampUs: number | null): React.ReactNode => {
    switch (displayTimeFormat) {
      case 'delta-last':
        if (prevTimestampUs === null) return '0.000s 000µs';
        return renderDeltaNode(timestampUs - prevTimestampUs);
      case 'delta-start':
        return renderDeltaNode(timestampUs - startTimeUs);
      case 'timestamp':
        return formatIsoUs(timestampUs);
      case 'human':
      default:
        return formatHumanUs(timestampUs);
    }
  }, [displayTimeFormat, startTimeUs]);

  // Track if user has scrolled up
  const handleScroll = () => {
    if (!containerRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = containerRef.current;
    wasAtBottom.current = scrollTop + clientHeight >= scrollHeight - 10;
  };

  // Follow the tail while streaming, unless the reader has scrolled away from it.
  useEffect(() => {
    if (hasBytes && isStreaming && autoScroll && wasAtBottom.current
        && containerRef.current && !isLoadingPage) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [hasBytes, isStreaming, autoScroll, backendBytes, isLoadingPage]);

  // Build display lines based on view mode
  const lines = useMemo(() => {
    const result: { timestamp: React.ReactNode; timestampUs: number | null; bus: number | null; hex: string; ascii: string }[] = [];
    let prevTimestampUs: number | null = null;

    if (viewConfig.displayMode === 'individual') {
      // Individual mode: each byte on its own line with precise timestamp
      for (const entry of displayEntries) {
        result.push({
          timestamp: formatTime(entry.timestampUs, prevTimestampUs),
          timestampUs: entry.timestampUs,
          bus: entry.bus ?? null,
          hex: byteToHex(entry.byte),
          ascii: byteToAscii(entry.byte),
        });
        prevTimestampUs = entry.timestampUs;
      }
    } else {
      // Chunked mode: group bytes by time gap
      const chunks = chunkBytesByGap(displayEntries, viewConfig.chunkGapUs);
      for (const chunk of chunks) {
        // Split chunk into lines of 16 bytes each
        for (let i = 0; i < chunk.bytes.length; i += 16) {
          const lineBytes = chunk.bytes.slice(i, Math.min(i + 16, chunk.bytes.length));
          const hex = lineBytes.map(byteToHex).join(' ');
          const ascii = lineBytes.map(byteToAscii).join('');

          result.push({
            timestamp: i === 0 ? formatTime(chunk.timestampUs, prevTimestampUs) : '',
            timestampUs: i === 0 ? chunk.timestampUs : null,
            bus: i === 0 ? (chunk.bus ?? null) : null,
            hex: hex.padEnd(47, ' '), // 16 bytes * 2 + 15 spaces = 47 chars
            ascii,
          });
          if (i === 0) {
            prevTimestampUs = chunk.timestampUs;
          }
        }
      }
    }

    return result;
  }, [displayEntries, viewConfig.displayMode, viewConfig.chunkGapUs, formatTime]);

  // Handle page size change
  const handlePageSizeChange = useCallback((newSize: PageSize) => {
    // No Auto here and the options are all numeric, so the modes are unreachable.
    if (typeof newSize !== 'number') return;
    setRawBytesPageSize(newSize);
    // Reset to first page when changing size (only applies when not streaming)
    setCurrentPage(0);
  }, [setRawBytesPageSize]);

  // Handle timeline scrub - find page containing the target timestamp
  const handleTimelineScrub = useCallback(async (targetTimeUs: number) => {
    if (!hasBytes || !bytesCaptureId) return;

    try {
      const offset = await findCaptureBytesOffsetForTimestamp(bytesCaptureId, targetTimeUs);
      setCurrentPage(pageForOffset(offset, pageSize));
    } catch (error) {
      console.error('Failed to seek to timestamp:', error);
    }
  }, [hasBytes, bytesCaptureId, pageSize]);

  // Current time for timeline (first byte timestamp on current page)
  const currentTimeUs = useMemo(() => {
    if (displayEntries.length > 0) {
      return displayEntries[0].timestampUs;
    }
    return timeRange?.min ?? 0;
  }, [displayEntries, timeRange]);

  // Byte count info for toolbar
  const byteCountInfo = (
    <span className={`text-xs ${textDataSecondary}`}>
      {t("serial.byteCount", { count: byteCount.toLocaleString() })}
      {isStreaming && (
        <span className={`ml-2 ${textDataGreen} bg-green-900/30 px-1.5 py-0.5 rounded font-medium`}>
          {t("serial.live")}
        </span>
      )}
    </span>
  );

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Toolbar - shown when using backend buffer */}
      {hasBytes && (
        <PaginationToolbar
          currentPage={currentPage}
          totalPages={totalPages}
          pageSize={pageSize}
          pageSizeOptions={BYTE_PAGE_SIZE_OPTIONS}
          onPageChange={setCurrentPage}
          onPageSizeChange={handlePageSizeChange}
          isLoading={isLoadingPage}
          disabled={isStreaming}
          leftContent={byteCountInfo}
          hidePagination={isStreaming}
        />
      )}

      {/* Timeline Scrubber - shown when using backend buffer with time range, only when not streaming */}
      <TimelineSection
        show={hasBytes && !isStreaming && timeRange !== null && timeRange.max > timeRange.min}
        minTimeUs={timeRange?.min ?? 0}
        maxTimeUs={timeRange?.max ?? 0}
        currentTimeUs={currentTimeUs}
        onPositionChange={handleTimelineScrub}
        displayTimeFormat={displayTimeFormat}
        streamStartTimeUs={timeRange?.min}
      />

      {/* Hex dump content */}
      <div
        ref={containerRef}
        onScroll={handleScroll}
        className={`${dataTableContainer} ${bgDataView}`}
      >
        {lines.length === 0 ? (
          <div className={`${textDataTertiary} text-center py-8`}>
            {isLoadingPage ? t("serial.loading") : t("serial.waitingForData")}
          </div>
        ) : (
          <>
            <table className="w-full">
              <thead className={`sticky top-0 z-10 ${bgDataView} ${textDataSecondary} shadow-sm`}>
                <tr>
                  <th className={`text-left ${dataHeaderCell}`}>{t("serial.headerTime")}</th>
                  {showBusColumn && <th className={`text-left ${dataHeaderCell}`}>{t("serial.headerBus")}</th>}
                  <th className={`text-left ${dataHeaderCell}`}>{t("serial.headerHex")}</th>
                  {showAsciiColumn && <th className={`text-left ${dataHeaderCell}`}>{t("serial.headerAscii")}</th>}
                </tr>
              </thead>
              <tbody>
                {lines.map((line, i) => (
                  <tr key={line.timestampUs ?? i} className={hoverDataRow}>
                    <td
                      className={`${textDataTertiary} ${dataCell} whitespace-nowrap`}
                      title={line.timestampUs !== null ? formatHumanUs(line.timestampUs) : undefined}
                    >
                      {line.timestamp}
                    </td>
                    {showBusColumn && (
                      <td className={`${textDataCyan} ${dataCell} whitespace-nowrap`}>
                        {line.bus !== null ? line.bus : ''}
                      </td>
                    )}
                    <td className={`${textDataGreen} ${dataCell} whitespace-nowrap`}>{line.hex}</td>
                    {showAsciiColumn && <td className={`${textDataYellow} ${dataCell} whitespace-nowrap`}>|{line.ascii}|</td>}
                  </tr>
                ))}
              </tbody>
            </table>
            {/* Bottom padding for scroll comfort */}
            <div className="h-8" />
          </>
        )}
      </div>
    </div>
  );
}
