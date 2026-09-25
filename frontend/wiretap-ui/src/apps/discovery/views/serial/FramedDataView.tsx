// ui/src/apps/discovery/views/serial/FramedDataView.tsx
//
// Display and configure framed serial data with ID/source/checksum extraction.

import { useEffect, useState, useMemo, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useDiscoveryStore } from '../../../../stores/discoveryStore';
import { useDiscoverySerialStore } from '../../../../stores/discoverySerialStore';
import { useDiscoveryUIStore } from '../../../../stores/discoveryUIStore';
import { useCaptureFrameView } from '../../hooks/useCaptureFrameView';
import type { ProtocolFrames } from '../../../../utils/frameKey';
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
import { bgSurface, borderDefault } from '../../../../styles';
import { resolvePageSize } from "../../../../utils/pageSize";
import type { TimeDisplayFormat } from "../../../../types/common";
import { Button } from "../../../../components/Button";

// ============================================================================
// Extraction Badge
// ============================================================================

interface ExtractionBadgeProps {
  label: string;
  config: ExtractionConfig | null;
  isActive: boolean;
  onClick: () => void;
  tone: 'cyan' | 'purple' | 'warning';
}

function ExtractionBadge({ label, config, isActive, onClick, tone }: ExtractionBadgeProps) {
  const { t } = useTranslation("discovery");

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
    <Button
      onClick={onClick}
      variant="outline"
      tone={tone}
      size="sm"
      pressed={isActive}
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
    </Button>
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

  const getAlgoLabel = (algo: DiscoveryChecksumAlgorithm) => {
    return CHECKSUM_ALGORITHMS.find(a => a.value === algo)?.label ?? algo;
  };

  return (
    <Button
      onClick={onClick}
      variant="outline"
      tone="warning"
      size="sm"
      pressed={isActive}
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
    </Button>
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
    const colors: string[] = new Array(bytes.length).fill(incomplete ? 'text-orange' : 'text-green');

    // Color ID bytes (cyan)
    if (idConfig) {
      const start = resolveByteIndexSync(idConfig.startByte, bytes.length);
      for (let i = start; i < start + idConfig.numBytes && i < bytes.length; i++) {
        colors[i] = 'text-cyan';
      }
    }

    // Color source bytes (purple) - may overlap with ID
    if (srcConfig) {
      const start = resolveByteIndexSync(srcConfig.startByte, bytes.length);
      for (let i = start; i < start + srcConfig.numBytes && i < bytes.length; i++) {
        colors[i] = 'text-purple';
      }
    }

    // Color checksum bytes (amber) - typically at end of frame
    if (checksumConfig) {
      const start = resolveByteIndexSync(checksumConfig.startByte, bytes.length);
      for (let i = start; i < start + checksumConfig.numBytes && i < bytes.length; i++) {
        colors[i] = 'text-amber';
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

/** Every frame in the capture: the Framed tab has no picker. */
const ALL_FRAMES: ProtocolFrames[] = [];

interface FramedDataViewProps {
  /** The capture to page — client-side framing's derived one or the session's own (`framedSource`). */
  captureId: string | null;
  /** Owning session, so a live tail refetches as the reader's frames land. */
  sessionId: string | null;
  onAccept: (serialConfig?: SerialFrameConfig) => void | Promise<unknown>;
  onApplyIdMapping: (config: ExtractionConfig) => void;
  onClearIdMapping?: () => void;
  onApplySourceMapping: (config: ExtractionConfig) => void;
  onClearSourceMapping?: () => void;
  accepted: boolean;
  framingMode?: string;
  displayTimeFormat?: TimeDisplayFormat;
  isStreaming?: boolean;
}

export default function FramedDataView({ captureId, sessionId, onAccept, onApplyIdMapping, onClearIdMapping, onApplySourceMapping, onClearSourceMapping, accepted, framingMode, displayTimeFormat = 'human', isStreaming = false }: FramedDataViewProps) {
  const { t } = useTranslation("discovery");
  // Column visibility from UI store (shared with CAN views and ByteView)
  const showBusColumn = useDiscoveryUIStore((s) => s.showBusColumn);
  const showAsciiColumn = useDiscoveryUIStore((s) => s.showAsciiColumn);
  // Read serialConfig from store to initialize extraction configs
  const serialConfig = useDiscoveryStore((s) => s.serialConfig);

  const pageSizeSetting = useDiscoverySerialStore((s) => s.framedPageSize);
  const setPageSize = useDiscoverySerialStore((s) => s.setFramedPageSize);
  const [autoRows, setAutoRows] = useState<number | null>(null);
  const pageSize = resolvePageSize(pageSizeSetting, autoRows);
  // Re-framing refills the derived capture under the same id.
  const framedDataTrigger = useDiscoverySerialStore((s) => s.framedDataTrigger);

  const {
    frames,
    totalCount,
    isLoading,
    currentPage,
    setCurrentPage,
    totalPages,
    timeRange: captureTimeRange,
    navigateToTimestamp,
  } = useCaptureFrameView({
    captureId,
    sessionId,
    isStreaming,
    selectedFrames: ALL_FRAMES,
    pageSize,
    tailSize: pageSize,
    revision: framedDataTrigger,
  });

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

  const hasSourceAddresses = frames.some(f => f.source_address !== undefined);

  // Sample frames for the byte-extraction dialogs, which only render 5 preview
  // rows — the current page is a fine source for that.
  const sampleFrames = useMemo(() => frames.slice(0, 50).map(f => f.bytes), [frames]);

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

  const timeRange = {
    min: captureTimeRange?.startUs ?? 0,
    max: captureTimeRange?.endUs ?? 0,
    current: frames[0]?.timestamp_us ?? captureTimeRange?.startUs ?? 0,
  };

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
        if (timeRange.min === 0) return '0.000000s';
        return renderDeltaNode(timestampUs - timeRange.min);
      case 'timestamp':
        return formatIsoUs(timestampUs);
      case 'human':
      default:
        return formatHumanUs(timestampUs);
    }
  }, [displayTimeFormat, timeRange.min]);

  // Apply ID and source extraction configs to frames for display
  // This is needed for streaming sessions where frames come directly from backend
  // without the extraction applied
  const processedFrames = useMemo(() => {
    if (!idConfig && !srcConfig) {
      return frames;
    }

    return frames.map(frame => {
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
  }, [frames, idConfig, srcConfig]);

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
      {!accepted && captureId !== null && (
        <div className={`flex-shrink-0 px-3 py-2 border-b ${borderDefault} ${bgSurface} flex items-center gap-3`}>
          {/* Extraction Badges */}
          <ExtractionBadge
            label={t("serial.extractionLabelId")}
            config={idConfig}
            isActive={idConfig !== null}
            onClick={() => setShowIdDialog(true)}
            tone="cyan"
          />
          <ExtractionBadge
            label={t("serial.extractionLabelSource")}
            config={srcConfig}
            isActive={srcConfig !== null}
            onClick={() => setShowSrcDialog(true)}
            tone="purple"
          />
          <ChecksumBadge
            config={checksumConfig}
            onClick={() => setShowChecksumDialog(true)}
          />

          <div className="flex-1" />

          <Button
            onClick={handleAccept}
            variant="solid"
            tone="success"
          >
            {t("serial.accept")}
          </Button>
        </div>
      )}

      {/* Pagination Toolbar - shown after accepting, when not streaming */}
      {accepted && !isStreaming && totalCount > 0 && (
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
          isLoading={isLoading}
        />
      )}

      {/* Timeline Scrubber - shown after accepting, when not streaming, with multiple frames */}
      <TimelineSection
        show={accepted && !isStreaming && totalCount > 1}
        minTimeUs={timeRange.min}
        maxTimeUs={timeRange.max}
        currentTimeUs={timeRange.current}
        onPositionChange={navigateToTimestamp}
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
        emptyMessage={isLoading ? t("serial.loadingFrames") : accepted ? t("serial.framingAccepted") : t("serial.applyFramingHint")}
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
        captureId={captureId}
        captureFrameCount={totalCount}
        initialConfig={checksumConfig}
        headerBoundaries={headerBoundaries}
        onApply={handleApplyChecksumConfig}
        onClear={checksumConfig ? handleClearChecksumConfig : undefined}
      />
    </div>
  );
}
