// ui/src/apps/discovery/views/serial/FramedDataView.tsx
//
// Display and configure framed serial data with ID/source/checksum extraction.

import { useEffect, useState, useMemo, useCallback } from 'react';
import { useDiscoveryStore, type FrameMessage } from '../../../../stores/discoveryStore';
import { useDiscoverySerialStore } from '../../../../stores/discoverySerialStore';
import { useDiscoveryToolboxStore } from '../../../../stores/discoveryToolboxStore';
import { useDiscoveryUIStore } from '../../../../stores/discoveryUIStore';
import { getBufferFramesPaginatedById, getBufferMetadataById, findBufferOffsetForTimestamp, type BufferFrame } from '../../../../api/buffer';
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
import FrameDataTable, { type FrameRow } from '../../components/FrameDataTable';
import { PaginationToolbar, TimelineSection, FRAME_PAGE_SIZE_OPTIONS } from '../../components';
import ByteExtractionDialog from './ByteExtractionDialog';
import ChecksumExtractionDialog from './ChecksumExtractionDialog';
import { bgDataToolbar, borderDataView } from '../../../../styles';

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
  const colorClasses = color === 'cyan'
    ? { active: 'bg-cyan-700 text-cyan-200 border-cyan-600', inactive: 'bg-gray-700 text-gray-400 border-gray-600' }
    : color === 'purple'
    ? { active: 'bg-purple-700 text-purple-200 border-purple-600', inactive: 'bg-gray-700 text-gray-400 border-gray-600' }
    : { active: 'bg-amber-700 text-amber-200 border-amber-600', inactive: 'bg-gray-700 text-gray-400 border-gray-600' };

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
      title={config ? `Bytes ${formatRange(config)}, ${config.endianness === 'big' ? 'BE' : 'LE'}` : 'Click to configure'}
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
  const isActive = config !== null;
  const colorClasses = {
    active: 'bg-amber-700 text-amber-200 border-amber-600',
    inactive: 'bg-gray-700 text-gray-400 border-gray-600'
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
      title={config ? `${getAlgoLabel(config.algorithm)}, bytes [${config.startByte}:${config.startByte + config.numBytes}]` : 'Click to configure checksum'}
    >
      Checksum
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
    <span className="whitespace-nowrap">
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
  displayTimeFormat?: 'delta-last' | 'delta-start' | 'timestamp' | 'human';
  isStreaming?: boolean;
}

export default function FramedDataView({ frames, onAccept, onApplyIdMapping, onClearIdMapping, onApplySourceMapping, onClearSourceMapping, accepted, framingMode, displayTimeFormat = 'human', isStreaming = false }: FramedDataViewProps) {
  // Column visibility from UI store (shared with CAN views and ByteView)
  const showBusColumn = useDiscoveryUIStore((s) => s.showBusColumn);
  const showAsciiColumn = useDiscoveryUIStore((s) => s.showAsciiColumn);
  // Read serialConfig from store to initialize extraction configs
  const serialConfig = useDiscoveryStore((s) => s.serialConfig);

  // Pagination state from store
  const pageSize = useDiscoverySerialStore((s) => s.framedPageSize);
  const setPageSize = useDiscoverySerialStore((s) => s.setFramedPageSize);

  // Backend buffer ID and frame count (set when framing is applied in backend)
  const framedBufferId = useDiscoverySerialStore((s) => s.framedBufferId);
  const backendFrameCount = useDiscoverySerialStore((s) => s.backendFrameCount);
  // Trigger to force refetch when framing is reapplied (even if buffer ID/count unchanged)
  const framedDataTrigger = useDiscoverySerialStore((s) => s.framedDataTrigger);

  // Local pagination state
  const [currentPage, setCurrentPage] = useState(0);

  // Backend buffer state
  const [backendFrames, setBackendFrames] = useState<FrameMessage[]>([]);
  const [backendTimeRange, setBackendTimeRange] = useState<{ min: number; max: number } | null>(null);
  const [isLoadingPage, setIsLoadingPage] = useState(false);

  // Determine if we're using backend buffer mode
  const useBackendBuffer = framedBufferId !== null;

  // Extraction configurations - read directly from serial store
  const idConfig = useDiscoverySerialStore((s) => s.frameIdExtractionConfig);
  const srcConfig = useDiscoverySerialStore((s) => s.sourceExtractionConfig);
  // Checksum config is local state since it's only used for TOML export, not stored in serial store
  const [checksumConfig, setChecksumConfig] = useState<ChecksumConfig | null>(null);

  // Dialog state
  const [showIdDialog, setShowIdDialog] = useState(false);
  const [showSrcDialog, setShowSrcDialog] = useState(false);
  const [showChecksumDialog, setShowChecksumDialog] = useState(false);

  // Get serial payload analysis results from toolbox store for checksum suggestions
  const serialPayloadResults = useDiscoveryToolboxStore((s) => s.toolbox.serialPayloadResults);

  // Derive suggested checksum config from serial payload analysis results
  const suggestedChecksumConfig = useMemo((): ChecksumConfig | null => {
    const analysisResult = serialPayloadResults?.analysisResult;
    if (!analysisResult?.candidateChecksums?.length) return null;

    // Find the best candidate (highest match rate, must be >= 80%)
    const bestCandidate = analysisResult.candidateChecksums[0];
    if (!bestCandidate || bestCandidate.matchRate < 80) return null;

    return {
      startByte: bestCandidate.position,
      numBytes: bestCandidate.length,
      endianness: 'big', // Default to big-endian for checksums
      algorithm: bestCandidate.algorithm,
      calcStartByte: bestCandidate.calcStartByte,
      calcEndByte: bestCandidate.calcEndByte,
    };
  }, [serialPayloadResults]);

  // Sync checksum config from store's serialConfig when it changes
  // (ID and source configs are read directly from serial store, not synced)
  useEffect(() => {
    if (serialConfig?.checksum) {
      setChecksumConfig({
        startByte: serialConfig.checksum.start_byte,
        numBytes: serialConfig.checksum.byte_length,
        endianness: 'big', // Checksums are typically big-endian
        algorithm: serialConfig.checksum.algorithm as DiscoveryChecksumAlgorithm,
        calcStartByte: serialConfig.checksum.calc_start_byte,
        calcEndByte: serialConfig.checksum.calc_end_byte,
      });
    } else if (!serialConfig) {
      setChecksumConfig(null);
    }
  }, [serialConfig]);

  // Fetch buffer metadata when backend buffer ID changes (for time range only)
  useEffect(() => {
    if (!framedBufferId) {
      setBackendFrames([]);
      setBackendTimeRange(null);
      return;
    }

    const fetchMetadata = async () => {
      try {
        const metadata = await getBufferMetadataById(framedBufferId);
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
  }, [framedBufferId]);

  // Fetch frames from backend when page changes or frame count updates (backend buffer mode)
  useEffect(() => {
    if (!useBackendBuffer || !framedBufferId || backendFrameCount === 0) return;

    const fetchPage = async () => {
      setIsLoadingPage(true);
      try {
        const effectiveSize = pageSize === -1 ? backendFrameCount : pageSize;
        // During streaming, always show the last page (latest frames)
        const offset = isStreaming
          ? Math.max(0, backendFrameCount - effectiveSize)
          : currentPage * effectiveSize;
        // Fetch from the specific frames buffer by ID (not the active buffer)
        const response = await getBufferFramesPaginatedById(framedBufferId, offset, effectiveSize);

        // Convert BufferFrame to FrameMessage
        const fetchedFrames: FrameMessage[] = response.frames.map((f: BufferFrame) => ({
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
        setIsLoadingPage(false);
      }
    };

    fetchPage();
  }, [useBackendBuffer, framedBufferId, currentPage, pageSize, backendFrameCount, isStreaming, framedDataTrigger]);

  // Filter to complete frames only (for prop-based frames)
  const completeFrames = useMemo(() => {
    if (useBackendBuffer) {
      return backendFrames; // Backend frames are already filtered
    }
    return frames.filter(f => !f.incomplete);
  }, [useBackendBuffer, backendFrames, frames]);

  // Total frame count - use store's backendFrameCount for backend mode (updates during streaming)
  const totalFrames = useBackendBuffer ? backendFrameCount : completeFrames.length;

  // Check if any frame has source_address set
  const hasSourceAddresses = useBackendBuffer
    ? backendFrames.some(f => f.source_address !== undefined)
    : frames.some(f => f.source_address !== undefined);

  // Sample frames for the dialog (more for checksum detection)
  const sampleFrames = useMemo(() => {
    const sourcFrames = useBackendBuffer ? backendFrames : completeFrames;
    return sourcFrames.slice(0, 50).map(f => f.bytes);
  }, [useBackendBuffer, backendFrames, completeFrames]);

  // Pagination calculations
  const effectivePageSize = pageSize === -1 ? totalFrames : pageSize;
  const totalPages = effectivePageSize > 0 ? Math.max(1, Math.ceil(totalFrames / effectivePageSize)) : 1;

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
    const startIndex = currentPage * effectivePageSize;
    const current = completeFrames[Math.min(startIndex, completeFrames.length - 1)]?.timestamp_us ?? min;
    return { min, max, current };
  }, [useBackendBuffer, backendTimeRange, backendFrames, completeFrames, currentPage, effectivePageSize]);

  // Handle timeline scrub - find page containing the target time
  const handleTimelineScrub = useCallback(async (targetTimeUs: number) => {
    if (useBackendBuffer) {
      // Use backend binary search to find offset
      try {
        const offset = await findBufferOffsetForTimestamp(targetTimeUs, []);
        const targetPage = Math.floor(offset / effectivePageSize);
        setCurrentPage(targetPage);
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

    // Calculate which page this frame is on
    const targetPage = Math.floor(targetIndex / effectivePageSize);
    setCurrentPage(targetPage);
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

    // Add checksum config
    if (checksumConfig) {
      serialConfigToSave.checksum = {
        algorithm: checksumConfig.algorithm,
        start_byte: checksumConfig.startByte,
        byte_length: checksumConfig.numBytes,
        calc_start_byte: checksumConfig.calcStartByte,
        calc_end_byte: checksumConfig.calcEndByte,
      };
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
            label="ID"
            config={idConfig}
            isActive={idConfig !== null}
            onClick={() => setShowIdDialog(true)}
            color="cyan"
          />
          <ExtractionBadge
            label="Source"
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
            Accept
          </button>
        </div>
      )}

      {/* Pagination Toolbar - shown after accepting, when not streaming */}
      {accepted && !isStreaming && totalFrames > 0 && (
        <PaginationToolbar
          currentPage={currentPage}
          totalPages={totalPages}
          pageSize={pageSize}
          pageSizeOptions={FRAME_PAGE_SIZE_OPTIONS}
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
        frames={processedFrames}
        displayFrameIdFormat="hex"
        formatTime={formatTime}
        showSourceAddress={hasSourceAddresses}
        sourceByteCount={srcConfig?.numBytes ?? 2}
        renderBytes={renderColoredBytes}
        emptyMessage={isLoadingPage ? 'Loading frames...' : accepted ? 'Framing accepted - data moved to Discovery' : 'Apply framing to see frames here'}
        showAscii={showAsciiColumn}
        showBus={showBusColumn}
        showId={idConfig !== null || (serialConfig?.frame_id_start_byte !== undefined && serialConfig?.frame_id_bytes !== undefined)}
      />

      {/* Extraction Dialogs */}
      <ByteExtractionDialog
        isOpen={showIdDialog}
        onClose={() => setShowIdDialog(false)}
        title="Configure Frame ID Extraction"
        sampleFrames={sampleFrames}
        initialConfig={idConfig ?? { startByte: 0, numBytes: 2, endianness: 'big' }}
        onApply={handleApplyIdConfig}
        onClear={idConfig ? handleClearIdConfig : undefined}
        color="cyan"
      />
      <ByteExtractionDialog
        isOpen={showSrcDialog}
        onClose={() => setShowSrcDialog(false)}
        title="Configure Source Address Extraction"
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
        initialConfig={checksumConfig ?? suggestedChecksumConfig}
        onApply={handleApplyChecksumConfig}
        onClear={checksumConfig ? handleClearChecksumConfig : undefined}
      />
    </div>
  );
}
