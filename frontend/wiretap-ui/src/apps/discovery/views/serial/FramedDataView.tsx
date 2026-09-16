// ui/src/apps/discovery/views/serial/FramedDataView.tsx
//
// Display and configure framed serial data with ID/source/checksum extraction.

import { useEffect, useState, useMemo, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useDiscoveryStore, type FrameMessage } from '../../../../stores/discoveryStore';
import { useDiscoverySerialStore } from '../../../../stores/discoverySerialStore';
import { useDiscoveryUIStore } from '../../../../stores/discoveryUIStore';
import { getCaptureFramesPaginatedById, getCaptureMetadataById, findCaptureOffsetForTimestamp, type CaptureFrame } from '../../../../api/capture';
import type { SerialFrameConfig } from '../../../../utils/frameExport';
import { resolveByteIndexSync } from '../../../../utils/analysis/checksums';
import {
  type ExtractionConfig,
  type ChecksumConfig,
  type DiscoveryChecksumAlgorithm,
  CHECKSUM_ALGORITHMS,
} from './serialTypes';
import { byteToHex } from '../../../../utils/byteUtils';
import { formatHumanUs, formatIsoUs, renderDeltaNode } from '../../../../utils/timeFormat';
import { frameCopyMenuItems, frameInspectMenuItem, menuSeparator } from '../../components/frameContextMenuItems';
import { useFrameIdFormat } from '../../../../hooks/useFrameIdFormat';
import FrameDataTable, { type FrameRow } from '../../components/FrameDataTable';
import ContextMenu, { type ContextMenuItem } from '../../../../components/ContextMenu';
import { PaginationToolbar, TimelineSection, FRAME_PAGE_SIZE_OPTIONS } from '../../components';
import ByteExtractionDialog from './ByteExtractionDialog';
import ChecksumExtractionDialog from './ChecksumExtractionDialog';
import { configFromSerialChecksum, serialChecksumFromConfig } from './checksumConfig';
import { bgDataToolbar, borderDataView, bgSurface, textSecondary, borderDefault } from '../../../../styles';
import { pageCount, pageForOffset, resolvePageSize } from "../../../../utils/pageSize";
import type { TimeDisplayFormat } from "../../../../types/common";

// ============================================================================
// Extraction Badge
// ============================================================================

interface ExtractionBadgeProps {
  label: string;
  config: ExtractionConfig | null;
  isActive: boolean;
  onClick: () => void;
  color: 'cyan' | 'purple' | 'amber';
}

function ExtractionBadge({ label, config, isActive, onClick, color }: ExtractionBadgeProps) {
  const { t } = useTranslation("discovery");
  const inactiveClasses = `${bgSurface} ${textSecondary} ${borderDefault}`;
  const colorClasses = color === 'cyan'
    ? { active: 'bg-cyan-700 text-cyan-200 border-cyan-600', inactive: inactiveClasses }
    : color === 'purple'
    ? { active: 'bg-purple-700 text-purple-200 border-purple-600', inactive: inactiveClasses }
    : { active: 'bg-amber-700 text-amber-200 border-amber-600', inactive: inactiveClasses };

  // Format the byte range - handle negative indices nicely
  const formatRange = (cfg: ExtractionConfig) => {
    if (cfg.startByte < 0) {
      // Negative index: show as [end-N:end-M]
      const endOffset = cfg.startByte + cfg.numBytes;
      return `[${cfg.startByte}:${endOffset === 0 ? 'end' : endOffset}]`;
    }
    return `[${cfg.startByte}:${cfg.startByte + cfg.numBytes - 1}]`;
  };

  return (
    <button
      onClick={onClick}
      className={`px-2.5 py-1 text-xs font-medium rounded border transition-colors ${
        isActive ? colorClasses.active : colorClasses.inactive
      } hover:opacity-80`}
      title={
        config
          ? t("serial.extractionTooltipBytes", {
              start: config.startByte,
              end: config.startByte + config.numBytes - 1,
              endian: config.endianness === 'big' ? 'BE' : 'LE',
            })
          : t("serial.extractionConfigure")
      }
    >
      {label}
      {config && isActive && (
        <span className="ml-1 opacity-75">{formatRange(config)}</span>
      )}
    </button>
  );
}

// ============================================================================
// Checksum Badge
// ============================================================================

interface ChecksumBadgeProps {
  config: ChecksumConfig | null;
  onClick: () => void;
}

function ChecksumBadge({ config, onClick }: ChecksumBadgeProps) {
  const { t } = useTranslation("discovery");
  const isActive = config !== null;
  const colorClasses = {
    active: 'bg-amber-700 text-amber-200 border-amber-600',
    inactive: `${bgSurface} ${textSecondary} ${borderDefault}`
  };

  const getAlgoLabel = (algo: DiscoveryChecksumAlgorithm) => {
    return CHECKSUM_ALGORITHMS.find(a => a.value === algo)?.label ?? algo;
  };

  return (
    <button
      onClick={onClick}
      className={`px-2.5 py-1 text-xs font-medium rounded border transition-colors ${
        isActive ? colorClasses.active : colorClasses.inactive
      } hover:opacity-80`}
      title={
        config
          ? t("serial.checksumTooltip", {
              algo: getAlgoLabel(config.algorithm),
              start: config.startByte,
              end: config.startByte + config.numBytes,
            })
          : t("serial.checksumConfigure")
      }
    >
      {t("serial.extractionLabelChecksum")}
      {config && isActive && (
        <span className="ml-1 opacity-75">{getAlgoLabel(config.algorithm)}</span>
      )}
    </button>
  );
}

// ============================================================================
// Colored Hex Bytes Component
// ============================================================================

interface ColoredHexBytesProps {
  bytes: number[];
  idConfig: ExtractionConfig | null;
  srcConfig: ExtractionConfig | null;
  checksumConfig: ChecksumConfig | null;
  incomplete?: boolean;
}

function ColoredHexBytes({ bytes, idConfig, srcConfig, checksumConfig, incomplete }: ColoredHexBytesProps) {
  // Build array of byte colors
  const byteColors = useMemo(() => {
    const colors: string[] = new Array(bytes.length).fill(incomplete ? 'text-orange-400' : 'text-green-400');

    // Color ID bytes (cyan)
    if (idConfig) {
      const start = resolveByteIndexSync(idConfig.startByte, bytes.length);
      for (let i = start; i < start + idConfig.numBytes && i < bytes.length; i++) {
        colors[i] = 'text-cyan-400';
      }
    }

    // Color source bytes (purple) - may overlap with ID
    if (srcConfig) {
      const start = resolveByteIndexSync(srcConfig.startByte, bytes.length);
      for (let i = start; i < start + srcConfig.numBytes && i < bytes.length; i++) {
        colors[i] = 'text-purple-400';
      }
    }

    // Color checksum bytes (amber) - typically at end of frame
    if (checksumConfig) {
      const start = resolveByteIndexSync(checksumConfig.startByte, bytes.length);
      for (let i = start; i < start + checksumConfig.numBytes && i < bytes.length; i++) {
        colors[i] = 'text-amber-400';
      }
    }

    return colors;
  }, [bytes.length, idConfig, srcConfig, checksumConfig, incomplete]);

  return (
    <span className="break-all">
      {bytes.map((byte, i) => (
        <span key={i} className={byteColors[i]}>
          {i > 0 ? ' ' : ''}{byteToHex(byte)}
        </span>
      ))}
    </span>
  );
}

// ============================================================================
// Framed Bytes View
// ============================================================================

interface FramedDataViewProps {
  frames: FrameMessage[];
  onAccept: (serialConfig?: SerialFrameConfig) => void | Promise<unknown>;
  onApplyIdMapping: (config: ExtractionConfig) => void;
  onClearIdMapping?: () => void;
  onApplySourceMapping: (config: ExtractionConfig) => void;
  onClearSourceMapping?: () => void;
  accepted: boolean;
  framingMode?: string;
  displayTimeFormat?: TimeDisplayFormat;
  isStreaming?: boolean;
  /**
   * The session's own frames capture, for a reader that frames for itself.
   *
   * Client-side framing derives a capture and puts its id in the serial store;
   * a SLIP or Modbus RTU reader frames on the wire and writes straight into the
   * session's capture, deriving nothing. Without this the tab counts frames it
   * has no way to page.
   */
  sessionFramesCaptureId: string | null;
  /** Frame count for `sessionFramesCaptureId`; drives the refetch while streaming. */
  sessionFramesCount: number;
}

export default function FramedDataView({ frames, onAccept, onApplyIdMapping, onClearIdMapping, onApplySourceMapping, onClearSourceMapping, accepted, framingMode, displayTimeFormat = 'human', isStreaming = false, sessionFramesCaptureId, sessionFramesCount }: FramedDataViewProps) {
  const { t } = useTranslation("discovery");
  // Column visibility from UI store (shared with CAN views and ByteView)
  const showBusColumn = useDiscoveryUIStore((s) => s.showBusColumn);
  const showAsciiColumn = useDiscoveryUIStore((s) => s.showAsciiColumn);
  // Read serialConfig from store to initialize extraction configs
  const serialConfig = useDiscoveryStore((s) => s.serialConfig);

  const pageSizeSetting = useDiscoverySerialStore((s) => s.framedPageSize);
  const setPageSize = useDiscoverySerialStore((s) => s.setFramedPageSize);
  const [autoRows, setAutoRows] = useState<number | null>(null);

  // Backend buffer ID and frame count (set when framing is applied in backend)
  const framedCaptureId = useDiscoverySerialStore((s) => s.framedCaptureId);
  const backendFrameCount = useDiscoverySerialStore((s) => s.backendFrameCount);
  // Trigger to force refetch when framing is reapplied (even if buffer ID/count unchanged)
  const framedDataTrigger = useDiscoverySerialStore((s) => s.framedDataTrigger);

  // Local pagination state
  const [currentPage, setCurrentPage] = useState(0);

  // Backend buffer state
  const fetchInFlightRef = useRef(false);
  const missedFetchRef = useRef(false);
  const [backendFrames, setBackendFrames] = useState<FrameMessage[]>([]);
  const [backendTimeRange, setBackendTimeRange] = useState<{ min: number; max: number } | null>(null);
  const [isLoadingPage, setIsLoadingPage] = useState(false);

  // Client-side framing pages its derived capture; otherwise the session's own,
  // where a reader that frames on the wire puts its frames. One decision, so the
  // id and the count cannot come from different sides.
  const [pagedCaptureId, pagedFrameCount] =
    framedCaptureId !== null
      ? ([framedCaptureId, backendFrameCount] as const)
      : ([sessionFramesCaptureId, sessionFramesCount] as const);

  // Determine if we're using backend buffer mode
  const useBackendBuffer = pagedCaptureId !== null;

  // Extraction configurations - read directly from serial store
  const idConfig = useDiscoverySerialStore((s) => s.frameIdExtractionConfig);
  const srcConfig = useDiscoverySerialStore((s) => s.sourceExtractionConfig);
  // Checksum config is local state since it's only used for TOML export, not stored in serial store
  const [checksumConfig, setChecksumConfig] = useState<ChecksumConfig | null>(null);

  // Dialog state
  const [showIdDialog, setShowIdDialog] = useState(false);
  const [showSrcDialog, setShowSrcDialog] = useState(false);
  const [showChecksumDialog, setShowChecksumDialog] = useState(false);

  // Row context menu — the home of the Inspect action that used to be a per-row
  // calculator icon. Mirrors the Frames and Filtered tabs so all three agree.
  const { format: formatId } = useFrameIdFormat();
  const [contextMenu, setContextMenu] = useState<{
    frame: FrameRow;
    position: { x: number; y: number };
  } | null>(null);

  const handleContextMenu = useCallback((frame: FrameRow, position: { x: number; y: number }) => {
    setContextMenu({ frame, position });
  }, []);

  const closeContextMenu = useCallback(() => setContextMenu(null), []);

  // Serial frames only carry an id when a field has been declared for one, so
  // Copy ID is offered on the same condition the column is.
  const showIdColumn =
    idConfig !== null ||
    (serialConfig?.frame_id_start_byte !== undefined && serialConfig?.frame_id_bytes !== undefined);

  const contextMenuItems: ContextMenuItem[] = useMemo(() => {
    if (!contextMenu) return [];
    const { frame } = contextMenu;
    return [
      ...frameCopyMenuItems({ frame, t, formatId, includeId: showIdColumn }),
      menuSeparator,
      frameInspectMenuItem(frame, t),
    ];
  }, [contextMenu, showIdColumn, formatId, t]);

  // Sync checksum config from store's serialConfig when it changes
  // (ID and source configs are read directly from serial store, not synced)
  useEffect(() => {
    if (serialConfig?.checksum) {
      setChecksumConfig(configFromSerialChecksum(serialConfig.checksum));
    } else if (!serialConfig) {
      setChecksumConfig(null);
    }
  }, [serialConfig]);

  // Fetch buffer metadata when backend buffer ID changes (for time range only)
  useEffect(() => {
    if (!pagedCaptureId) {
      setBackendFrames([]);
      setBackendTimeRange(null);
      return;
    }

    const fetchMetadata = async () => {
      try {
        const metadata = await getCaptureMetadataById(pagedCaptureId);
        if (metadata) {
          if (metadata.start_time_us !== null && metadata.end_time_us !== null) {
            setBackendTimeRange({ min: metadata.start_time_us, max: metadata.end_time_us });
          }
        }
      } catch (error) {
        console.error('Failed to fetch buffer metadata:', error);
      }
    };

    fetchMetadata();
    setCurrentPage(0); // Reset to first page when buffer changes
  }, [pagedCaptureId]);

  // Filter to complete frames only (for prop-based frames)
  const completeFrames = useMemo(() => {
    if (useBackendBuffer) {
      return backendFrames; // Backend frames are already filtered
    }
    return frames.filter(f => !f.incomplete);
  }, [useBackendBuffer, backendFrames, frames]);

  // Total frame count - use the paged capture's count for backend mode (updates during streaming)
  const totalFrames = useBackendBuffer ? pagedFrameCount : completeFrames.length;

  // The one resolved page size in this component — declared above the fetch effect so the
  // effect closes over it rather than resolving a second time from its own arguments.
  const effectivePageSize = resolvePageSize(pageSizeSetting, autoRows, totalFrames);

  // Fetch frames from backend when page changes or frame count updates (backend buffer mode)
  useEffect(() => {
    // The null check belongs in the condition, with the size in the deps, so the fetch
    // re-runs when the measurement lands — see docs/capture-flow.md § Auto rows-per-page.
    if (!useBackendBuffer || !pagedCaptureId || pagedFrameCount === 0) return;
    if (effectivePageSize === null) return;

    // A tail fetch can outlast the 500ms frame-count signal on a large capture.
    // Skip while one is in flight and run once more on completion, so fetches can
    // neither queue up on the capture-store mutex nor land out of order and
    // overwrite newer rows with older ones — the same guard `useCaptureFrameView`
    // documents for the CAN tail, which this path now shares the cadence of.
    if (fetchInFlightRef.current) {
      missedFetchRef.current = true;
      return;
    }

    const fetchPage = async () => {
      fetchInFlightRef.current = true;
      // The pagination toolbar is hidden while streaming, so a spinner there is
      // two wasted renders per tick.
      if (!isStreaming) setIsLoadingPage(true);
      try {
        // During streaming, always show the last page (latest frames)
        const offset = isStreaming
          ? Math.max(0, pagedFrameCount - effectivePageSize)
          : currentPage * effectivePageSize;
        // Fetch from the specific frames buffer by ID (not the active buffer)
        const response = await getCaptureFramesPaginatedById(pagedCaptureId, offset, effectivePageSize);

        // Convert CaptureFrame to FrameMessage
        const fetchedFrames: FrameMessage[] = response.frames.map((f: CaptureFrame) => ({
          protocol: f.protocol,
          timestamp_us: f.timestamp_us,
          frame_id: f.frame_id,
          bus: f.bus,
          dlc: f.dlc,
          bytes: f.bytes,
          is_extended: f.is_extended,
          is_fd: f.is_fd,
          source_address: f.source_address,
          incomplete: false,
        }));

        setBackendFrames(fetchedFrames);
      } catch (error) {
        console.error('Failed to fetch frames from backend:', error);
        setBackendFrames([]);
      } finally {
        fetchInFlightRef.current = false;
        if (!isStreaming) setIsLoadingPage(false);
        if (missedFetchRef.current) {
          missedFetchRef.current = false;
          fetchPage();
        }
      }
    };

    fetchPage();
  }, [useBackendBuffer, pagedCaptureId, currentPage, effectivePageSize, pagedFrameCount, isStreaming, framedDataTrigger]);

  // Check if any frame has source_address set
  const hasSourceAddresses = useBackendBuffer
    ? backendFrames.some(f => f.source_address !== undefined)
    : frames.some(f => f.source_address !== undefined);

  // Sample frames for the byte-extraction dialogs, which only render 5 preview
  // rows — the current page is a fine source for that.
  const sampleFrames = useMemo(() => {
    const sourcFrames = useBackendBuffer ? backendFrames : completeFrames;
    return sourcFrames.slice(0, 50).map(f => f.bytes);
  }, [useBackendBuffer, backendFrames, completeFrames]);

  /**
   * Byte just past each declared header field. Hints for where the checksummed
   * range might start — they widen the search, never narrow it.
   */
  const headerBoundaries = useMemo(() => {
    const boundaries: number[] = [];
    for (const cfg of [idConfig, srcConfig]) {
      if (cfg && cfg.startByte >= 0) boundaries.push(cfg.startByte + cfg.numBytes);
    }
    return boundaries;
  }, [idConfig, srcConfig]);

  const totalPages = pageCount(totalFrames, effectivePageSize);

  // Reset page when streaming starts or when frame count changes significantly
  useEffect(() => {
    if (isStreaming) {
      setCurrentPage(0);
    }
  }, [isStreaming]);

  // Clamp current page when total pages decreases
  useEffect(() => {
    if (currentPage >= totalPages) {
      setCurrentPage(Math.max(0, totalPages - 1));
    }
  }, [currentPage, totalPages]);

  // Time range for timeline scrubber
  const timeRange = useMemo(() => {
    if (useBackendBuffer) {
      if (!backendTimeRange) return { min: 0, max: 0, current: 0 };
      const current = backendFrames[0]?.timestamp_us ?? backendTimeRange.min;
      return { min: backendTimeRange.min, max: backendTimeRange.max, current };
    }
    if (completeFrames.length === 0) return { min: 0, max: 0, current: 0 };
    const min = completeFrames[0].timestamp_us;
    const max = completeFrames[completeFrames.length - 1].timestamp_us;
    const startIndex = currentPage * (effectivePageSize ?? 0);
    const current = completeFrames[Math.min(startIndex, completeFrames.length - 1)]?.timestamp_us ?? min;
    return { min, max, current };
  }, [useBackendBuffer, backendTimeRange, backendFrames, completeFrames, currentPage, effectivePageSize]);

  // Handle timeline scrub - find page containing the target time
  const handleTimelineScrub = useCallback(async (targetTimeUs: number) => {
    if (useBackendBuffer) {
      // Use backend binary search to find offset
      try {
        const offset = await findCaptureOffsetForTimestamp(pagedCaptureId!, targetTimeUs, []);
        setCurrentPage(pageForOffset(offset, effectivePageSize));
      } catch (error) {
        console.error('Failed to seek to timestamp:', error);
      }
      return;
    }

    if (completeFrames.length === 0) return;

    // Linear scan to find frame at or just after target time
    let targetIndex = 0;
    for (let i = 0; i < completeFrames.length; i++) {
      if (completeFrames[i].timestamp_us >= targetTimeUs) {
        targetIndex = i;
        break;
      }
      targetIndex = i; // Last frame if target is after all frames
    }

    setCurrentPage(pageForOffset(targetIndex, effectivePageSize));
  }, [useBackendBuffer, completeFrames, effectivePageSize]);

  const handleApplyIdConfig = (config: ExtractionConfig) => {
    onApplyIdMapping(config);
  };

  const handleClearIdConfig = () => {
    onClearIdMapping?.();
  };

  const handleApplySrcConfig = (config: ExtractionConfig) => {
    onApplySourceMapping(config);
  };

  const handleClearSrcConfig = () => {
    onClearSourceMapping?.();
  };

  const handleApplyChecksumConfig = (config: ChecksumConfig) => {
    setChecksumConfig(config);
    // Checksum is for validation/export only, no frame update needed
  };

  const handleClearChecksumConfig = () => {
    setChecksumConfig(null);
  };

  // Build SerialFrameConfig from extraction configs for TOML export
  const handleAccept = () => {
    const serialConfigToSave: SerialFrameConfig = {
      encoding: framingMode,
    };

    // Add ID extraction config
    if (idConfig) {
      serialConfigToSave.frame_id_start_byte = idConfig.startByte;
      serialConfigToSave.frame_id_bytes = idConfig.numBytes;
      serialConfigToSave.frame_id_byte_order = idConfig.endianness;
    }

    // Add source address config
    if (srcConfig) {
      serialConfigToSave.source_address_start_byte = srcConfig.startByte;
      serialConfigToSave.source_address_bytes = srcConfig.numBytes;
      serialConfigToSave.source_address_byte_order = srcConfig.endianness;
    }

    // Add checksum config (null for the 'unknown' placeholder, which no
    // catalogue can decode)
    if (checksumConfig) {
      serialConfigToSave.checksum = serialChecksumFromConfig(checksumConfig) ?? undefined;
    }

    onAccept(serialConfigToSave);
  };

  // Format time for the table based on settings
  const formatTime = useCallback((timestampUs: number, prevTimestampUs: number | null) => {
    switch (displayTimeFormat) {
      case 'delta-last':
        if (prevTimestampUs === null) return '0.000000s';
        return renderDeltaNode(timestampUs - prevTimestampUs);
      case 'delta-start':
        // Use time range min for delta-start (works for both local and backend modes)
        if (timeRange.min === 0) return '0.000000s';
        return renderDeltaNode(timestampUs - timeRange.min);
      case 'timestamp':
        return formatIsoUs(timestampUs);
      case 'human':
      default:
        return formatHumanUs(timestampUs);
    }
  }, [displayTimeFormat, timeRange.min]);

  // Prepare frames for display with pagination
  const displayFrames = useMemo(() => {
    if (useBackendBuffer) {
      // In backend buffer mode, frames are fetched paginated
      return backendFrames;
    }
    // Auto fit not measured yet — the slices below would silently come back empty.
    if (effectivePageSize === null) return [];
    if (isStreaming) {
      // During streaming, show latest frames (auto-scroll behavior)
      const startIndex = Math.max(0, totalFrames - effectivePageSize);
      return completeFrames.slice(startIndex);
    }
    // After streaming/accept, paginate normally
    const startIndex = currentPage * effectivePageSize;
    const endIndex = startIndex + effectivePageSize;
    return completeFrames.slice(startIndex, endIndex);
  }, [useBackendBuffer, backendFrames, completeFrames, isStreaming, totalFrames, effectivePageSize, currentPage]);

  // Apply ID and source extraction configs to frames for display
  // This is needed for streaming sessions where frames come directly from backend
  // without the extraction applied
  const processedFrames = useMemo(() => {
    if (!idConfig && !srcConfig) {
      return displayFrames;
    }

    return displayFrames.map(frame => {
      let newFrame = { ...frame };

      // Apply ID extraction if configured
      if (idConfig) {
        const { startByte, numBytes, endianness } = idConfig;
        const resolvedStart = startByte >= 0 ? startByte : Math.max(0, frame.bytes.length + startByte);
        if (resolvedStart < frame.bytes.length) {
          let frameId = 0;
          const endByte = Math.min(resolvedStart + numBytes, frame.bytes.length);
          if (endianness === 'big') {
            for (let i = resolvedStart; i < endByte; i++) {
              frameId = (frameId << 8) | frame.bytes[i];
            }
          } else {
            for (let i = resolvedStart; i < endByte; i++) {
              frameId |= frame.bytes[i] << (8 * (i - resolvedStart));
            }
          }
          newFrame.frame_id = frameId;
        }
      }

      // Apply source extraction if configured
      if (srcConfig) {
        const { startByte, numBytes, endianness } = srcConfig;
        const resolvedStart = startByte >= 0 ? startByte : Math.max(0, frame.bytes.length + startByte);
        if (resolvedStart < frame.bytes.length) {
          let source = 0;
          const endByte = Math.min(resolvedStart + numBytes, frame.bytes.length);
          if (endianness === 'big') {
            for (let i = resolvedStart; i < endByte; i++) {
              source = (source << 8) | frame.bytes[i];
            }
          } else {
            for (let i = resolvedStart; i < endByte; i++) {
              source |= frame.bytes[i] << (8 * (i - resolvedStart));
            }
          }
          newFrame.source_address = source;
        }
      }

      return newFrame;
    });
  }, [displayFrames, idConfig, srcConfig]);

  // Custom byte renderer with extraction region coloring
  const renderColoredBytes = useCallback((frame: FrameRow) => {
    return (
      <ColoredHexBytes
        bytes={frame.bytes}
        idConfig={idConfig}
        srcConfig={srcConfig}
        checksumConfig={checksumConfig}
        incomplete={frame.incomplete}
      />
    );
  }, [idConfig, srcConfig, checksumConfig]);

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Toolbar - hidden after accepting */}
      {!accepted && (totalFrames > 0 || useBackendBuffer) && (
        <div className={`flex-shrink-0 px-3 py-2 border-b ${borderDataView} ${bgDataToolbar} flex items-center gap-3`}>
          {/* Extraction Badges */}
          <ExtractionBadge
            label={t("serial.extractionLabelId")}
            config={idConfig}
            isActive={idConfig !== null}
            onClick={() => setShowIdDialog(true)}
            color="cyan"
          />
          <ExtractionBadge
            label={t("serial.extractionLabelSource")}
            config={srcConfig}
            isActive={srcConfig !== null}
            onClick={() => setShowSrcDialog(true)}
            color="purple"
          />
          <ChecksumBadge
            config={checksumConfig}
            onClick={() => setShowChecksumDialog(true)}
          />

          <div className="flex-1" />

          <button
            onClick={handleAccept}
            className="px-4 py-1.5 text-sm bg-green-600 hover:bg-green-500 rounded font-medium"
          >
            {t("serial.accept")}
          </button>
        </div>
      )}

      {/* Pagination Toolbar - shown after accepting, when not streaming */}
      {accepted && !isStreaming && totalFrames > 0 && (
        <PaginationToolbar
          currentPage={currentPage}
          totalPages={totalPages}
          pageSize={pageSizeSetting}
          pageSizeOptions={FRAME_PAGE_SIZE_OPTIONS}
          allowAuto
          onPageChange={setCurrentPage}
          onPageSizeChange={(size) => {
            setPageSize(size);
            setCurrentPage(0);
          }}
          isLoading={isLoadingPage}
        />
      )}

      {/* Timeline Scrubber - shown after accepting, when not streaming, with multiple frames */}
      <TimelineSection
        show={accepted && !isStreaming && totalFrames > 1}
        minTimeUs={timeRange.min}
        maxTimeUs={timeRange.max}
        currentTimeUs={timeRange.current}
        onPositionChange={handleTimelineScrub}
        displayTimeFormat={displayTimeFormat}
        streamStartTimeUs={timeRange.min}
      />

      {/* Frame Table */}
      <FrameDataTable
        displayTimeFormat={displayTimeFormat}
        frames={processedFrames}
        formatTime={formatTime}
        showSourceAddress={hasSourceAddresses}
        sourceByteCount={srcConfig?.numBytes ?? 2}
        renderBytes={renderColoredBytes}
        emptyMessage={isLoadingPage ? t("serial.loadingFrames") : accepted ? t("serial.framingAccepted") : t("serial.applyFramingHint")}
        showAscii={showAsciiColumn}
        showBus={showBusColumn}
        autoFit={pageSizeSetting === "auto"}
        onFitChange={setAutoRows}
        showId={showIdColumn}
        onContextMenu={handleContextMenu}
      />

      {contextMenu && (
        <ContextMenu
          items={contextMenuItems}
          position={contextMenu.position}
          onClose={closeContextMenu}
        />
      )}

      {/* Extraction Dialogs */}
      <ByteExtractionDialog
        isOpen={showIdDialog}
        onClose={() => setShowIdDialog(false)}
        title={t("serial.frameIdExtractionTitle")}
        sampleFrames={sampleFrames}
        initialConfig={idConfig ?? { startByte: 0, numBytes: 2, endianness: 'big' }}
        onApply={handleApplyIdConfig}
        onClear={idConfig ? handleClearIdConfig : undefined}
        color="cyan"
      />
      <ByteExtractionDialog
        isOpen={showSrcDialog}
        onClose={() => setShowSrcDialog(false)}
        title={t("serial.sourceAddressExtractionTitle")}
        sampleFrames={sampleFrames}
        initialConfig={srcConfig ?? { startByte: 2, numBytes: 2, endianness: 'big' }}
        onApply={handleApplySrcConfig}
        onClear={srcConfig ? handleClearSrcConfig : undefined}
        color="purple"
      />
      <ChecksumExtractionDialog
        isOpen={showChecksumDialog}
        onClose={() => setShowChecksumDialog(false)}
        sampleFrames={sampleFrames}
        captureId={pagedCaptureId}
        captureFrameCount={pagedFrameCount}
        initialConfig={checksumConfig}
        headerBoundaries={headerBoundaries}
        onApply={handleApplyChecksumConfig}
        onClear={checksumConfig ? handleClearChecksumConfig : undefined}
      />
    </div>
  );
}
