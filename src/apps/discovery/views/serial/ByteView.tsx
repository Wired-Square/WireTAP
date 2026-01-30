// ui/src/apps/discovery/views/serial/ByteView.tsx
//
// Scrolling hex dump display for raw serial bytes with timestamps.
// Supports backend buffer pagination for large captures.

import { useEffect, useRef, useMemo, useState, useCallback } from 'react';
import type { SerialBytesEntry, RawBytesViewConfig } from '../../../../stores/discoveryStore';
import { useDiscoverySerialStore } from '../../../../stores/discoverySerialStore';
import { useDiscoveryUIStore } from '../../../../stores/discoveryUIStore';
import { getBufferBytesPaginated, getBufferMetadata, findBufferBytesOffsetForTimestamp, type TimestampedByte } from '../../../../api/buffer';
import { byteToHex, byteToAscii } from '../../../../utils/byteUtils';
import { formatHumanUs, formatIsoUs, renderDeltaNode } from '../../../../utils/timeFormat';
import { PaginationToolbar, TimelineSection, BYTE_PAGE_SIZE_OPTIONS } from '../../components';
import {
  bgDataView,
  borderDataView,
  textDataSecondary,
  textDataTertiary,
  hoverDataRow,
  textDataGreen,
  textDataYellow,
  textDataCyan,
} from '../../../../styles';

interface ByteViewProps {
  entries: SerialBytesEntry[];
  viewConfig: RawBytesViewConfig;
  autoScroll?: boolean;
  displayTimeFormat?: 'delta-last' | 'delta-start' | 'timestamp' | 'human';
  /** Whether we're currently streaming data */
  isStreaming?: boolean;
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

export default function ByteView({ entries, viewConfig, autoScroll = true, displayTimeFormat = 'human', isStreaming = false }: ByteViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const wasAtBottom = useRef(true);

  // Column visibility from UI store (shared with CAN views)
  const showBusColumn = useDiscoveryUIStore((s) => s.showBusColumn);
  const showAsciiColumn = useDiscoveryUIStore((s) => s.showAsciiColumn);

  // Backend buffer state from store
  const backendByteCount = useDiscoverySerialStore((s) => s.backendByteCount);
  const rawBytesPageSize = useDiscoverySerialStore((s) => s.rawBytesPageSize);
  const setRawBytesPageSize = useDiscoverySerialStore((s) => s.setRawBytesPageSize);
  const bufferReadyTrigger = useDiscoverySerialStore((s) => s.bufferReadyTrigger);

  // Local pagination state (only used when not streaming)
  const [currentPage, setCurrentPage] = useState(0);
  const [backendBytes, setBackendBytes] = useState<SerialBytesEntry[]>([]);
  const [isLoadingPage, setIsLoadingPage] = useState(false);

  // Time range for timeline scrubber (from buffer metadata)
  const [timeRange, setTimeRange] = useState<{ min: number; max: number } | null>(null);

  // Use backend buffer when we have a byte count > 0
  const useBackendBuffer = backendByteCount > 0;

  // Pagination calculations for backend mode
  const totalBytes = useBackendBuffer ? backendByteCount : entries.length;
  const pageSize = rawBytesPageSize;
  const totalPages = Math.max(1, Math.ceil(totalBytes / pageSize));

  // When streaming stops, jump to the last page
  const prevIsStreamingRef = useRef(isStreaming);
  useEffect(() => {
    if (prevIsStreamingRef.current && !isStreaming && useBackendBuffer) {
      // Streaming just stopped - jump to last page
      setCurrentPage(Math.max(0, totalPages - 1));
    }
    prevIsStreamingRef.current = isStreaming;
  }, [isStreaming, useBackendBuffer, totalPages]);

  // Clamp current page when total pages decreases (but only when not streaming)
  useEffect(() => {
    if (!isStreaming && currentPage >= totalPages) {
      setCurrentPage(Math.max(0, totalPages - 1));
    }
  }, [isStreaming, currentPage, totalPages]);

  // Fetch buffer metadata for time range (for timeline scrubber)
  useEffect(() => {
    if (!useBackendBuffer) {
      setTimeRange(null);
      return;
    }

    const fetchMetadata = async () => {
      try {
        const metadata = await getBufferMetadata();
        if (metadata && metadata.start_time_us !== null && metadata.end_time_us !== null) {
          setTimeRange({ min: metadata.start_time_us, max: metadata.end_time_us });
        }
      } catch (error) {
        console.error('Failed to fetch buffer metadata:', error);
      }
    };

    fetchMetadata();
  }, [useBackendBuffer, backendByteCount]);

  // Fetch bytes from backend buffer after streaming stops.
  // During streaming, we use frontend entries (from events) instead.
  // Note: backendByteCount is in the dependency array to ensure refetch when stream
  // ends and we switch from streaming to buffer mode.
  useEffect(() => {
    // Track whether this effect instance is still current
    let cancelled = false;

    // Don't fetch during streaming - use frontend entries instead
    if (!useBackendBuffer || isStreaming) {
      setBackendBytes([]);
      return;
    }

    const fetchPage = async () => {
      setIsLoadingPage(true);
      try {
        // Pagination mode: show page based on currentPage
        const offset = currentPage * pageSize;
        const response = await getBufferBytesPaginated(offset, pageSize);

        // Only update state if this effect instance is still current
        if (cancelled) return;

        const fetchedEntries: SerialBytesEntry[] = response.bytes.map((b: TimestampedByte) => ({
          byte: b.byte,
          timestampUs: b.timestamp_us,
          bus: b.bus,
        }));
        setBackendBytes(fetchedEntries);
      } catch (error) {
        if (cancelled) return;
        // Suppress "No active buffer" errors - this is expected during the brief transition
        // between stream end (when buffer is finalized) and setActiveBuffer() being called
        const errorStr = String(error);
        if (!errorStr.includes('No active buffer')) {
          console.error('Failed to fetch bytes from backend:', error);
        }
        setBackendBytes([]);
      } finally {
        if (!cancelled) {
          setIsLoadingPage(false);
        }
      }
    };

    fetchPage();

    return () => {
      cancelled = true;
    };
  }, [useBackendBuffer, isStreaming, currentPage, pageSize, bufferReadyTrigger]);

  // Determine which entries to display
  // During streaming, use frontend entries (from events) since backend fetch may fail
  // After streaming stops, use backend buffer if available
  const displayEntries = (useBackendBuffer && !isStreaming) ? backendBytes : entries;

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

  // Auto-scroll to bottom when new entries arrive (frontend mode)
  useEffect(() => {
    if (!useBackendBuffer && autoScroll && wasAtBottom.current && containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [entries, autoScroll, useBackendBuffer]);

  // Auto-scroll to bottom during streaming (backend mode)
  useEffect(() => {
    if (useBackendBuffer && isStreaming && containerRef.current && !isLoadingPage) {
      // During streaming, always scroll to bottom to show latest bytes
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [useBackendBuffer, isStreaming, backendBytes, isLoadingPage]);

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
  const handlePageSizeChange = useCallback((newSize: number) => {
    setRawBytesPageSize(newSize);
    // Reset to first page when changing size (only applies when not streaming)
    setCurrentPage(0);
  }, [setRawBytesPageSize]);

  // Handle timeline scrub - find page containing the target timestamp
  const handleTimelineScrub = useCallback(async (targetTimeUs: number) => {
    if (!useBackendBuffer) return;

    try {
      // Use backend binary search to find byte offset for timestamp
      const offset = await findBufferBytesOffsetForTimestamp(targetTimeUs);
      const targetPage = Math.floor(offset / pageSize);
      setCurrentPage(targetPage);
    } catch (error) {
      console.error('Failed to seek to timestamp:', error);
    }
  }, [useBackendBuffer, pageSize]);

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
      {totalBytes.toLocaleString()} bytes
      {isStreaming && (
        <span className={`ml-2 ${textDataGreen} bg-green-900/30 px-1.5 py-0.5 rounded font-medium`}>
          LIVE
        </span>
      )}
    </span>
  );

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Toolbar - shown when using backend buffer */}
      {useBackendBuffer && (
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
        show={useBackendBuffer && !isStreaming && timeRange !== null && timeRange.max > timeRange.min}
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
        className={`flex-1 overflow-auto font-mono text-xs ${bgDataView}`}
      >
        {lines.length === 0 ? (
          <div className={`${textDataTertiary} text-center py-8`}>
            {isLoadingPage ? 'Loading...' : 'Waiting for serial data...'}
          </div>
        ) : (
          <>
            <table className="w-full">
              <thead className={`sticky top-0 z-10 ${bgDataView} ${textDataSecondary} shadow-sm`}>
                <tr>
                  <th className={`text-left px-2 py-1.5 border-b ${borderDataView}`}>Time</th>
                  {showBusColumn && <th className={`text-left px-2 py-1.5 border-b ${borderDataView}`}>Bus</th>}
                  <th className={`text-left px-2 py-1.5 border-b ${borderDataView}`}>Hex</th>
                  {showAsciiColumn && <th className={`text-left px-2 py-1.5 border-b ${borderDataView}`}>ASCII</th>}
                </tr>
              </thead>
              <tbody>
                {lines.map((line, i) => (
                  <tr key={i} className={hoverDataRow}>
                    <td
                      className={`${textDataTertiary} px-2 py-0.5 whitespace-nowrap`}
                      title={line.timestampUs !== null ? formatHumanUs(line.timestampUs) : undefined}
                    >
                      {line.timestamp}
                    </td>
                    {showBusColumn && (
                      <td className={`${textDataCyan} px-2 py-0.5 whitespace-nowrap`}>
                        {line.bus !== null ? line.bus : ''}
                      </td>
                    )}
                    <td className={`${textDataGreen} px-2 py-0.5 whitespace-nowrap`}>{line.hex}</td>
                    {showAsciiColumn && <td className={`${textDataYellow} px-2 py-0.5 whitespace-nowrap`}>|{line.ascii}|</td>}
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
