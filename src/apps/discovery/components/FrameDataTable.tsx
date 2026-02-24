// ui/src/apps/discovery/components/FrameDataTable.tsx
//
// Shared frame data table component for Discovery views.
// Displays frames in a dark-themed table with configurable columns and actions.

import { ReactNode, useMemo, forwardRef, useRef, useEffect } from 'react';
import { Calculator, Bookmark } from 'lucide-react';
import { iconXs } from '../../../styles/spacing';
import { formatFrameId as formatId } from '../../../utils/frameIds';
import { sendHexDataToCalculator } from '../../../utils/windowCommunication';
import { bytesToHex, bytesToAscii } from '../../../utils/byteUtils';
import { formatHumanUs } from '../../../utils/timeFormat';
import {
  bgDataView,
  borderDataView,
  textDataSecondary,
  textDataTertiary,
  hoverDataRow,
  textDataGreen,
  textDataYellow,
  textDataOrange,
  textDataPurple,
  textDataAmber,
  textDataCyan,
  bgCyan,
} from '../../../styles';
import { tableIconButtonDark } from '../../../styles/buttonStyles';

// ============================================================================
// Types
// ============================================================================

export interface FrameRow {
  timestamp_us: number;
  frame_id: number;
  is_extended?: boolean;
  source_address?: number;
  dlc: number;
  bytes: number[];
  /** Pre-computed hex bytes for display */
  hexBytes?: string[];
  /** Mark frame as incomplete (serial framing) */
  incomplete?: boolean;
  /** CAN bus number (0-255) */
  bus?: number;
}

export interface FrameDataTableProps {
  /** Frames to display */
  frames: FrameRow[];
  /** Format for frame ID display */
  displayFrameIdFormat: 'hex' | 'decimal';
  /** Format time display - callback receives current and previous timestamp */
  formatTime: (timestampUs: number, prevTimestampUs: number | null) => ReactNode;
  /** Whether to show source address column */
  showSourceAddress?: boolean;
  /** Called when bookmark button is clicked (omit to hide bookmark button) */
  onBookmark?: (frameId: number, timestampUs: number) => void;
  /** Called when calculator button is clicked (omit to hide calculator button) */
  onCalculator?: (bytes: number[]) => void;
  /** Show calculator button (default: true if onCalculator not provided, uses default handler) */
  showCalculator?: boolean;
  /** Custom row renderer for additional columns or styling */
  renderExtraColumns?: (frame: FrameRow, index: number) => ReactNode;
  /** Empty state message */
  emptyMessage?: string;
  /** Number of source bytes for padding (serial extraction) */
  sourceByteCount?: number;
  /** Custom byte renderer (for colored extraction regions in serial) */
  renderBytes?: (frame: FrameRow) => ReactNode;
  /** Show ASCII column (default: false) */
  showAscii?: boolean;
  /** Show bus number column (default: false) */
  showBus?: boolean;
  /** Show frame reference # column (default: true) */
  showRef?: boolean;
  /** Show frame ID column (default: true) - set to false for serial frames */
  showId?: boolean;
  /** Auto-scroll to bottom when new frames arrive (default: true) */
  autoScroll?: boolean;
  /** Index of the row to highlight within the visible frames (0-based) */
  highlightedRowIndex?: number | null;
  /** Called when a row is clicked (receives row index within visible frames) */
  onRowClick?: (rowIndex: number) => void;
  /** Called when a row is right-clicked (receives frame data and mouse position) */
  onContextMenu?: (frame: FrameRow, position: { x: number; y: number }) => void;
  /** Starting frame index for the current page (for tooltip display) */
  pageStartIndex?: number;
  /** Whether frames were reversed for display (affects frame index calculation) */
  framesReversed?: boolean;
  /** Total frames on this page (needed when reversed to calculate correct index) */
  pageFrameCount?: number;
  /** 1-based original buffer positions for each frame. When provided, used for # column instead of computed page offset. */
  bufferIndices?: number[];
}

// ============================================================================
// Component
// ============================================================================

const FrameDataTable = forwardRef<HTMLDivElement, FrameDataTableProps>(({
  frames,
  displayFrameIdFormat,
  formatTime,
  showSourceAddress = false,
  onBookmark,
  onCalculator,
  showCalculator = true,
  renderExtraColumns,
  emptyMessage = 'No frames to display',
  sourceByteCount = 2,
  renderBytes,
  showRef = true,
  showAscii = false,
  showBus = false,
  showId = true,
  autoScroll = true,
  highlightedRowIndex,
  onRowClick,
  onContextMenu,
  pageStartIndex = 0,
  framesReversed = false,
  pageFrameCount = 0,
  bufferIndices,
}, ref) => {
  // Internal ref for scrolling (use forwarded ref if provided, otherwise internal)
  const internalRef = useRef<HTMLDivElement>(null);
  const containerRef = (ref as React.RefObject<HTMLDivElement>) || internalRef;
  const wasAtBottom = useRef(true);
  const highlightedRowRef = useRef<HTMLTableRowElement>(null);

  // Track if user has scrolled up
  const handleScroll = () => {
    const container = containerRef.current;
    if (!container) return;
    const { scrollTop, scrollHeight, clientHeight } = container;
    wasAtBottom.current = scrollTop + clientHeight >= scrollHeight - 10;
  };

  // Auto-scroll to bottom when new frames arrive (streaming mode)
  useEffect(() => {
    const container = containerRef.current;
    if (autoScroll && wasAtBottom.current && container) {
      container.scrollTop = container.scrollHeight;
    }
  }, [frames, autoScroll, containerRef]);

  // Scroll to keep highlighted row visible when stepping or page changes
  useEffect(() => {
    if (highlightedRowIndex != null && highlightedRowRef.current) {
      // Use requestAnimationFrame to ensure DOM has updated after page change
      requestAnimationFrame(() => {
        highlightedRowRef.current?.scrollIntoView({
          behavior: 'smooth',
          block: 'nearest',
        });
      });
    }
  }, [highlightedRowIndex, frames]);

  // Check if any frame has source_address
  const hasSourceAddress = useMemo(() => {
    if (showSourceAddress) return true;
    return frames.some(frame => frame.source_address !== undefined);
  }, [frames, showSourceAddress]);

  // Default calculator handler
  const handleCalculator = async (bytes: number[]) => {
    if (onCalculator) {
      onCalculator(bytes);
    } else {
      const hexData = bytesToHex(bytes);
      await sendHexDataToCalculator(hexData);
    }
  };

  // Default byte renderer
  const defaultRenderBytes = (frame: FrameRow) => {
    const hexBytes = frame.hexBytes ?? frame.bytes.map(b => b.toString(16).padStart(2, '0').toUpperCase());
    return (
      <span className={`whitespace-nowrap ${frame.incomplete ? textDataOrange : textDataGreen}`}>
        {hexBytes.join(' ')}
      </span>
    );
  };

  return (
    <div
      ref={ref || internalRef}
      className={`flex-1 min-h-0 overflow-auto font-mono text-xs ${bgDataView}`}
      onScroll={handleScroll}
    >
      <table className="w-full">
        <thead className={`sticky top-0 z-10 ${bgDataView} ${textDataSecondary}`}>
          <tr>
            {onBookmark && (
              <th className={`px-1 py-1.5 w-6 border-b ${borderDataView}`}></th>
            )}
            {showRef && (
              <th className={`text-right px-2 py-1.5 w-14 border-b ${borderDataView} ${textDataSecondary}`}>#</th>
            )}
            <th className={`text-left px-2 py-1.5 border-b ${borderDataView}`}>Time</th>
            {showId && (
              <th className={`text-right px-2 py-1.5 border-b ${borderDataView}`}>ID</th>
            )}
            {showBus && (
              <th className={`text-center px-2 py-1.5 w-10 border-b ${borderDataView} ${textDataCyan}`}>Bus</th>
            )}
            {hasSourceAddress && (
              <th className={`text-right px-2 py-1.5 border-b ${borderDataView} ${textDataPurple}`}>Source</th>
            )}
            <th className={`text-left px-2 py-1.5 w-10 border-b ${borderDataView}`}>Len</th>
            {showCalculator && (
              <th className={`px-1 py-1.5 w-6 border-b ${borderDataView}`}></th>
            )}
            <th className={`text-left px-2 py-1.5 border-b ${borderDataView}`}>Data</th>
            {showAscii && (
              <th className={`text-left px-2 py-1.5 border-b ${borderDataView}`}>ASCII</th>
            )}
          </tr>
        </thead>
        <tbody>
          {frames.map((frame, idx, arr) => {
            const prevFrame = idx > 0 ? arr[idx - 1] : null;
            const srcPadding = sourceByteCount * 2;
            const isCurrentFrame = highlightedRowIndex != null && idx === highlightedRowIndex;
            // Calculate actual frame index - if reversed, count down from end of page
            const frameIndex = framesReversed
              ? pageStartIndex + pageFrameCount - 1 - idx
              : pageStartIndex + idx;
            // Use buffer index (1-based buffer position) when available, otherwise fall back to page offset
            const displayIndex = bufferIndices?.[idx] ?? (frameIndex + 1);
            // Cell highlight class - apply to each td for consistent rendering across browsers
            const cellHighlight = isCurrentFrame ? bgCyan : '';

            return (
              <tr
                ref={isCurrentFrame ? highlightedRowRef : undefined}
                key={`${frame.timestamp_us}-${frame.frame_id}-${idx}`}
                className={`${isCurrentFrame ? '' : hoverDataRow} ${frame.incomplete ? 'opacity-60' : ''} ${isCurrentFrame ? 'ring-1 ring-[color:var(--status-cyan-border)]' : ''} ${onRowClick ? 'cursor-pointer' : ''}`}
                title={`Frame ${displayIndex}${frame.incomplete ? ' - Incomplete (no delimiter found)' : ''}`}
                onClick={onRowClick ? () => onRowClick(idx) : undefined}
                onContextMenu={onContextMenu ? (e) => { e.preventDefault(); onContextMenu(frame, { x: e.clientX, y: e.clientY }); } : undefined}
              >
                {onBookmark && (
                  <td className={`px-1 py-0.5 ${cellHighlight}`}>
                    <button
                      onClick={() => onBookmark(frame.frame_id, frame.timestamp_us)}
                      className={tableIconButtonDark}
                      title="Add bookmark at this frame's time"
                    >
                      <Bookmark className={`${iconXs} ${textDataAmber}`} />
                    </button>
                  </td>
                )}
                {showRef && (
                  <td className={`px-2 py-0.5 text-right tabular-nums ${textDataTertiary} ${cellHighlight}`}>
                    {displayIndex.toLocaleString()}
                  </td>
                )}
                <td
                  className={`px-2 py-0.5 ${cellHighlight}`}
                  title={formatHumanUs(frame.timestamp_us)}
                >
                  <span className={textDataTertiary}>{formatTime(frame.timestamp_us, prevFrame?.timestamp_us ?? null)}</span>
                </td>
                {showId && (
                  <td className={`px-2 py-0.5 text-right ${frame.incomplete ? textDataOrange : textDataYellow} ${cellHighlight}`}>
                    {formatId(frame.frame_id, displayFrameIdFormat, frame.is_extended)}
                    {frame.incomplete && <span className={`ml-1 ${textDataOrange}`}>?</span>}
                  </td>
                )}
                {showBus && (
                  <td className={`px-2 py-0.5 text-center ${textDataCyan} ${cellHighlight}`}>
                    {frame.bus ?? 0}
                  </td>
                )}
                {hasSourceAddress && (
                  <td className={`px-2 py-0.5 text-right ${textDataPurple} ${cellHighlight}`}>
                    {frame.source_address !== undefined
                      ? `0x${frame.source_address.toString(16).toUpperCase().padStart(srcPadding, '0')}`
                      : '-'
                    }
                  </td>
                )}
                <td className={`px-2 py-0.5 ${textDataSecondary} ${cellHighlight}`}>{frame.dlc}</td>
                {showCalculator && (
                  <td className={`px-1 py-0.5 ${cellHighlight}`}>
                    <button
                      onClick={() => handleCalculator(frame.bytes)}
                      className={tableIconButtonDark}
                      title="Send to Frame Calculator"
                    >
                      <Calculator className={`${iconXs} ${textDataOrange}`} />
                    </button>
                  </td>
                )}
                <td className={`px-2 py-0.5 ${cellHighlight}`}>
                  {renderBytes ? renderBytes(frame) : defaultRenderBytes(frame)}
                </td>
                {showAscii && (
                  <td className={`px-2 py-0.5 ${textDataYellow} whitespace-nowrap ${cellHighlight}`}>
                    |{bytesToAscii(frame.bytes)}|
                  </td>
                )}
                {renderExtraColumns?.(frame, idx)}
              </tr>
            );
          })}
        </tbody>
      </table>
      {frames.length === 0 ? (
        <div className={`${textDataTertiary} text-center py-8`}>
          {emptyMessage}
        </div>
      ) : (
        /* Bottom padding for scroll comfort */
        <div className="h-8" />
      )}
    </div>
  );
});

FrameDataTable.displayName = 'FrameDataTable';

export default FrameDataTable;
