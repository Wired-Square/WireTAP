// ui/src/apps/decoder/views/DecoderFramesView.tsx

import { useRef, useEffect, useState, useMemo } from "react";
import { Calculator, Star, Clock, Check, X } from "lucide-react";
import { iconSm, iconXs, flexRowGap2 } from "../../../styles/spacing";
import { PlaybackControls } from "../../../components/PlaybackControls";
import { validateChecksum, type ChecksumAlgorithm, type ChecksumValidationResult } from "../../../api/checksums";
import { badgeDarkPanelInfo, badgeDarkPanelSuccess, badgeDarkPanelDanger, badgeDarkPanelPurple } from "../../../styles/badgeStyles";
import { caption, bgSurface } from "../../../styles";
import type { PlaybackState, PlaybackSpeed } from "../../../components/TimeController";
import type { IOCapabilities } from '../../../api/io';
import { formatFrameId } from "../../../utils/frameIds";
import { sendHexDataToCalculator } from "../../../utils/windowCommunication";
import AppTabView, { type TabDefinition, type ProtocolBadge } from "../../../components/AppTabView";
import HeaderFieldFilter from "../../../components/HeaderFieldFilter";
import type { DecodedFrame, DecodedSignal, DecoderViewMode, UnmatchedFrame, FilteredFrame } from "../../../stores/decoderStore";
import { MAX_UNMATCHED_FRAMES, MAX_FILTERED_FRAMES } from "../../../stores/decoderStore";
import type { FrameDetail, SignalDef, MuxDef } from "../../../types/decoder";
import type { SerialFrameConfig } from "../../../utils/frameExport";
import type { TimeFormat } from "../../../hooks/useSettings";

/**
 * Get the byte indices that a signal covers based on start_bit and bit_length.
 * Returns a Set of byte indices (0-indexed).
 */
function getSignalByteIndices(signal: SignalDef): Set<number> {
  const indices = new Set<number>();
  const startBit = signal.start_bit ?? 0;
  const bitLength = signal.bit_length ?? 8;

  // Calculate which bytes this signal spans
  const startByte = Math.floor(startBit / 8);
  const endBit = startBit + bitLength - 1;
  const endByte = Math.floor(endBit / 8);

  for (let i = startByte; i <= endByte; i++) {
    indices.add(i);
  }

  return indices;
}

/**
 * Recursively collect all signals from a mux structure (all cases).
 */
function collectMuxSignals(mux: MuxDef): SignalDef[] {
  const signals: SignalDef[] = [];
  for (const caseData of Object.values(mux.cases)) {
    signals.push(...caseData.signals);
    if (caseData.mux) {
      signals.push(...collectMuxSignals(caseData.mux));
    }
  }
  return signals;
}

/**
 * Get all signals for a frame (plain + all mux signals).
 */
function getAllSignals(frame: FrameDetail): SignalDef[] {
  const signals = [...frame.signals];
  if (frame.mux) {
    signals.push(...collectMuxSignals(frame.mux));
  }
  return signals;
}

type Props = {
  frames: FrameDetail[];
  selectedIds: Set<number>;
  decoded: Map<number, DecodedFrame>;
  /** Decoded frames keyed by "frameId:sourceAddress" for per-source view mode */
  decodedPerSource: Map<string, DecodedFrame>;
  /** View mode: 'single' shows most recent per frame, 'per-source' shows by source address */
  viewMode: DecoderViewMode;
  displayFrameIdFormat: "hex" | "decimal";
  isDecoding: boolean;
  showRawBytes: boolean;
  onToggleRawBytes: () => void;
  /** Current timestamp in epoch seconds */
  timestamp?: number | null;
  /** @deprecated Use timestamp instead */
  displayTime?: string | null;
  /** Protocol type from catalog (default_frame) */
  protocol?: "can" | "serial";
  /** Serial frame configuration from catalog (for badges display) */
  serialConfig?: SerialFrameConfig | null;
  /** Frames that don't match any frame ID in the catalog */
  unmatchedFrames?: UnmatchedFrame[];
  /** Frames that were filtered out (e.g., too short) */
  filteredFrames?: FilteredFrame[];

  // Playback controls (for buffer replay)
  isReady: boolean;
  playbackState: PlaybackState;
  playbackDirection?: "forward" | "backward";
  capabilities?: IOCapabilities | null;
  onPlay: () => void;
  onPlayBackward?: () => void;
  onPause: () => void;
  onStepBackward?: () => void;
  onStepForward?: () => void;

  // Speed control (for buffer replay)
  playbackSpeed?: PlaybackSpeed;
  onSpeedChange?: (speed: PlaybackSpeed) => void;

  // Whether we have buffer data available for replay
  hasBufferData?: boolean;

  // Time range / bookmark
  activeBookmarkId?: string | null;
  onOpenBookmarkPicker?: () => void;
  showTimeRange?: boolean;
  onToggleTimeRange?: () => void;
  startTime?: string;
  endTime?: string;
  onStartTimeChange?: (time: string) => void;
  onEndTimeChange?: (time: string) => void;

  // Timeline scrubber
  minTimeUs?: number | null;
  maxTimeUs?: number | null;
  currentTimeUs?: number | null;
  currentFrameIndex?: number | null;
  totalFrames?: number | null;
  onScrub?: (timeUs: number) => void;

  signalColours?: {
    none?: string;
    low?: string;
    medium?: string;
    high?: string;
  };

  // Header field filters
  headerFieldFilters?: Map<string, Set<number>>;
  onToggleHeaderFieldFilter?: (fieldName: string, value: number) => void;
  onClearHeaderFieldFilter?: (fieldName: string) => void;
  /** Accumulated header field values seen across all frames */
  seenHeaderFieldValues?: Map<string, Map<number, { display: string; count: number }>>;

  /** Hide frames that haven't been seen (decoded) yet */
  hideUnseen?: boolean;

  /** Time format for displaying signal timestamps */
  displayTimeFormat?: TimeFormat;

  /** Stream start time in epoch seconds for delta-start calculation */
  streamStartTimeSeconds?: number | null;

  /** Active tab ID */
  activeTab?: string;
  /** Callback when tab changes */
  onTabChange?: (tabId: string) => void;

  /** Show ASCII gutter in unmatched/filtered tabs */
  showAsciiGutter?: boolean;
  /** Frame ID filter for unmatched/filtered tabs */
  frameIdFilter?: string;
};

/**
 * Format a signal value for display, including raw value for enums.
 */
function formatSignalValue(decoded: DecodedSignal): string {
  if (decoded.format === 'enum' && decoded.rawValue !== undefined) {
    // For enums, show the label with raw value in parentheses
    // But only if the display value doesn't already contain the raw value
    if (!decoded.value.includes(`(${decoded.rawValue})`)) {
      return `${decoded.value} (${decoded.rawValue})`;
    }
  }
  return `${decoded.value}${decoded.unit ? ` ${decoded.unit}` : ""}`;
}

/**
 * Format a signal timestamp for display based on the time format setting.
 * Uses short format suitable for inline display.
 * @param timestamp - Signal timestamp in epoch seconds
 * @param format - Display format from settings
 * @param startTimeSeconds - Optional start time for delta-start calculation (epoch seconds)
 */
function formatSignalTimestamp(
  timestamp: number | undefined,
  format: TimeFormat,
  startTimeSeconds?: number
): string {
  if (timestamp === undefined) return "";

  switch (format) {
    case "human": {
      // Short time only: HH:MM:SS
      const date = new Date(timestamp * 1000);
      return date.toLocaleTimeString('en-US', {
        hour12: false,
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
      });
    }
    case "timestamp":
      // Unix timestamp (seconds) - show with 3 decimal places
      return timestamp.toFixed(3);
    case "delta-start": {
      // Delta from start time in seconds
      if (startTimeSeconds !== undefined) {
        const deltaSeconds = timestamp - startTimeSeconds;
        return `+${deltaSeconds.toFixed(1)}s`;
      }
      // Fallback to human time if no start time available
      const date = new Date(timestamp * 1000);
      return date.toLocaleTimeString('en-US', {
        hour12: false,
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
      });
    }
    case "delta-last":
      // For delta-last, we'd need per-signal tracking which is complex
      // Show human time as fallback - delta-last doesn't make sense for signal view
      // since we show "last update time" not a stream of updates
      {
        const date = new Date(timestamp * 1000);
        return date.toLocaleTimeString('en-US', {
          hour12: false,
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit'
        });
      }
    default: {
      const date = new Date(timestamp * 1000);
      return date.toLocaleTimeString('en-US', {
        hour12: false,
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
      });
    }
  }
}

/**
 * Brighten a colour by interpolating towards white.
 * Amount is 0-1, where 1 is fully white.
 */
function brightenColour(colour: string, amount: number): string {
  // Handle hex colours
  if (colour.startsWith('#')) {
    const hex = colour.slice(1);
    const r = parseInt(hex.slice(0, 2), 16);
    const g = parseInt(hex.slice(2, 4), 16);
    const b = parseInt(hex.slice(4, 6), 16);
    const newR = Math.round(r + (255 - r) * amount);
    const newG = Math.round(g + (255 - g) * amount);
    const newB = Math.round(b + (255 - b) * amount);
    return `rgb(${newR}, ${newG}, ${newB})`;
  }
  // For non-hex colours, return white for flash
  return `rgb(255, 255, 255)`;
}

/**
 * Component for a single frame card with flash effect on update.
 */
// Minimum time between flashes (ms) - ensures consistent flash rate across all frames
const MIN_FLASH_INTERVAL = 500;

function FrameCard({
  frame,
  decodedFrame,
  displayFrameIdFormat,
  showRawBytes,
  signalColours,
  sourceAddressLabel,
  serialConfig,
  displayTimeFormat = "human",
  onToggleHeaderFieldFilter,
  startTimeSeconds,
}: {
  frame: FrameDetail;
  decodedFrame: DecodedFrame | undefined;
  displayFrameIdFormat: "hex" | "decimal";
  showRawBytes: boolean;
  signalColours?: {
    none?: string;
    low?: string;
    medium?: string;
    high?: string;
  };
  /** Source address to display as a label (for per-source view mode) */
  sourceAddressLabel?: number;
  /** Serial config for extracting checksum info */
  serialConfig?: SerialFrameConfig | null;
  /** Time format for signal timestamps */
  displayTimeFormat?: TimeFormat;
  /** Callback for header field badge clicks to toggle filter */
  onToggleHeaderFieldFilter?: (fieldName: string, value: number) => void;
  /** Start time in epoch seconds for delta-start calculation */
  startTimeSeconds?: number;
}) {
  // Track which byte indices are currently "bright" (recently changed)
  const [brightByteIndices, setBrightByteIndices] = useState<Set<number>>(new Set());
  const prevBytesRef = useRef<number[] | null>(null);
  const lastFlashTimeRef = useRef<number>(0);
  const pendingFlashRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Track per-byte timeout handles so we can reset them when bytes change again
  const byteTimeoutsRef = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());

  const decodedSignals = decodedFrame?.signals || [];
  const rawBytes = decodedFrame?.rawBytes;
  const bytesKey = rawBytes ? rawBytes.join(',') : null;

  // Flash when bytes change, but rate-limit to ensure consistent flash rate
  // If a byte changes again while still bright, reset its timeout to stay bright longer
  useEffect(() => {
    if (rawBytes && prevBytesRef.current !== null) {
      // Find which bytes changed
      const changed = new Set<number>();
      for (let i = 0; i < rawBytes.length; i++) {
        if (prevBytesRef.current[i] !== rawBytes[i]) {
          changed.add(i);
        }
      }

      if (changed.size > 0) {
        const now = Date.now();
        const timeSinceLastFlash = now - lastFlashTimeRef.current;

        // Clear any pending flash scheduling
        if (pendingFlashRef.current) {
          clearTimeout(pendingFlashRef.current);
          pendingFlashRef.current = null;
        }

        const triggerFlash = () => {
          lastFlashTimeRef.current = Date.now();

          // Add changed bytes to bright set and reset their individual timeouts
          setBrightByteIndices((prev) => {
            const next = new Set(prev);
            for (const idx of changed) {
              next.add(idx);

              // Clear existing timeout for this byte if any
              const existingTimeout = byteTimeoutsRef.current.get(idx);
              if (existingTimeout) {
                clearTimeout(existingTimeout);
              }

              // Set new timeout to remove this byte from bright set
              // Use longer timeout than MIN_FLASH_INTERVAL so constantly-changing signals stay bright
              const timeout = setTimeout(() => {
                setBrightByteIndices((current) => {
                  const updated = new Set(current);
                  updated.delete(idx);
                  return updated;
                });
                byteTimeoutsRef.current.delete(idx);
              }, MIN_FLASH_INTERVAL + 100);
              byteTimeoutsRef.current.set(idx, timeout);
            }
            return next;
          });
        };

        if (timeSinceLastFlash >= MIN_FLASH_INTERVAL) {
          // Enough time has passed, flash immediately
          triggerFlash();
        } else {
          // Schedule flash for when the interval has passed
          const delay = MIN_FLASH_INTERVAL - timeSinceLastFlash;
          pendingFlashRef.current = setTimeout(triggerFlash, delay);
        }
      }
    }
    prevBytesRef.current = rawBytes ? [...rawBytes] : null;

    return () => {
      if (pendingFlashRef.current) {
        clearTimeout(pendingFlashRef.current);
      }
    };
  }, [bytesKey, rawBytes]);

  // Cleanup all byte timeouts on unmount
  useEffect(() => {
    return () => {
      for (const timeout of byteTimeoutsRef.current.values()) {
        clearTimeout(timeout);
      }
    };
  }, []);

  const renderFrameId = (id: number, isExtended?: boolean) => formatFrameId(id, displayFrameIdFormat, isExtended);

  const colourForConfidence = (conf?: string) => {
    switch (conf) {
      case "low":
        return signalColours?.low;
      case "medium":
        return signalColours?.medium;
      case "high":
        return signalColours?.high;
      case "none":
      default:
        return signalColours?.none;
    }
  };

  // Check if any of a signal's bytes are currently bright
  const signalHasBrightBytes = (signal: SignalDef): boolean => {
    if (brightByteIndices.size === 0) return false;
    const signalBytes = getSignalByteIndices(signal);
    for (const byteIdx of signalBytes) {
      if (brightByteIndices.has(byteIdx)) {
        return true;
      }
    }
    return false;
  };

  // Get text colour with optional flash brightening (only if signal's bytes are bright)
  const getTextColour = (baseColour: string | undefined, signal: SignalDef | undefined) => {
    if (signal && signalHasBrightBytes(signal)) {
      // When flashing, brighten the colour significantly
      if (baseColour) {
        return brightenColour(baseColour, 0.7);
      }
      // For default colours, use bright white
      return 'rgb(255, 255, 255)';
    }
    return baseColour;
  };

  const allSignals = getAllSignals(frame);

  // Build a mapping from byte index to the confidence colour of the signal that covers it
  // If multiple signals cover a byte, use the first one found (priority based on definition order)
  const byteColourMap = new Map<number, string | undefined>();
  for (const signal of allSignals) {
    const byteIndices = getSignalByteIndices(signal);
    const colour = colourForConfidence(signal.confidence);
    for (const idx of byteIndices) {
      if (!byteColourMap.has(idx)) {
        byteColourMap.set(idx, colour);
      }
    }
  }

  // Get colour for a specific byte, with optional flash brightening
  const getByteColour = (byteIdx: number) => {
    const baseColour = byteColourMap.get(byteIdx) ?? signalColours?.none;
    if (brightByteIndices.has(byteIdx) && baseColour) {
      return brightenColour(baseColour, 0.7);
    }
    return baseColour;
  };

  const headerFields = decodedFrame?.headerFields ?? [];

  // Async checksum validation state
  const [checksumResult, setChecksumResult] = useState<ChecksumValidationResult | null>(null);

  // Validate checksum asynchronously when raw bytes change
  useEffect(() => {
    if (!serialConfig?.checksum || !rawBytes || rawBytes.length === 0) {
      setChecksumResult(null);
      return;
    }

    const { algorithm, start_byte, byte_length, calc_start_byte, calc_end_byte, big_endian } = serialConfig.checksum;

    // Validate the checksum via Tauri backend
    validateChecksum(
      algorithm as ChecksumAlgorithm,
      rawBytes,
      start_byte,
      byte_length,
      big_endian ?? false,
      calc_start_byte,
      calc_end_byte
    )
      .then(setChecksumResult)
      .catch((err) => {
        console.warn('[FrameCard] checksum validation failed:', err);
        setChecksumResult(null);
      });
  }, [serialConfig?.checksum, rawBytes]);

  // Map built-in field names to friendly display names
  const getFriendlyFieldName = (name: string): string => {
    switch (name) {
      case 'source_address': return 'Source';
      case 'destination_address': return 'Dest';
      default: return name;
    }
  };

  // Get badge style based on field name (built-in vs custom)
  const getFieldBadgeStyle = (name: string): string => {
    switch (name) {
      case 'source_address':
      case 'destination_address':
        return badgeDarkPanelInfo; // Blue for built-in fields
      default:
        return badgeDarkPanelPurple; // Purple for custom fields
    }
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-3 text-sm font-semibold text-slate-800 dark:text-slate-100">
        <span className="font-mono">{renderFrameId(frame.id, frame.isExtended)}</span>
        <span className={caption}>len {frame.len}</span>
        {/* Header field badges - clickable to toggle filter */}
        {headerFields.length > 0 && headerFields.map((field) => (
          onToggleHeaderFieldFilter ? (
            <button
              key={field.name}
              onClick={() => onToggleHeaderFieldFilter(field.name, field.value)}
              className={`${getFieldBadgeStyle(field.name)} cursor-pointer hover:opacity-80 transition-opacity`}
              title={`Click to filter by ${getFriendlyFieldName(field.name)}: ${field.display}`}
            >
              {getFriendlyFieldName(field.name)}: {field.display}
            </button>
          ) : (
            <span key={field.name} className={getFieldBadgeStyle(field.name)}>
              {getFriendlyFieldName(field.name)}: {field.display}
            </span>
          )
        ))}
        {/* Legacy source address badge (for CAN/J1939) - clickable to toggle filter */}
        {sourceAddressLabel !== undefined && headerFields.length === 0 && (
          onToggleHeaderFieldFilter ? (
            <button
              onClick={() => onToggleHeaderFieldFilter('source_address', sourceAddressLabel)}
              className={`${badgeDarkPanelInfo} cursor-pointer hover:opacity-80 transition-opacity`}
              title={`Click to filter by Source: 0x${sourceAddressLabel.toString(16).toUpperCase().padStart(2, '0')}`}
            >
              Source: 0x{sourceAddressLabel.toString(16).toUpperCase().padStart(2, '0')}
            </button>
          ) : (
            <span className={badgeDarkPanelInfo}>
              Source: 0x{sourceAddressLabel.toString(16).toUpperCase().padStart(2, '0')}
            </span>
          )
        )}
        {/* Checksum badge - always last */}
        {checksumResult && (
          <span className={checksumResult.valid ? badgeDarkPanelSuccess : badgeDarkPanelDanger}>
            {checksumResult.valid ? <Check className={iconXs} /> : <X className={iconXs} />}
            Checksum: 0x{checksumResult.extracted.toString(16).toUpperCase().padStart(2, '0')}
          </span>
        )}
      </div>
      {/* Raw bytes on separate line */}
      {showRawBytes && rawBytes && (
        <div className="font-mono text-xs bg-slate-100 dark:bg-slate-700 px-2 py-0.5 rounded inline-block">
          {rawBytes.map((b, idx) => (
            <span
              key={idx}
              className="transition-colors duration-200"
              style={{ color: getByteColour(idx) }}
            >
              {idx > 0 ? ' ' : ''}
              {b.toString(16).toUpperCase().padStart(2, '0')}
            </span>
          ))}
        </div>
      )}
      <div className="rounded border border-slate-200 dark:border-slate-700">
        {(() => {
          // Separate plain signals (no muxValue) from mux signals
          const plainSignals = decodedSignals.filter(s => s.muxValue === undefined);
          const muxSignals = decodedSignals.filter(s => s.muxValue !== undefined);

          // Group mux signals by mux value
          const muxGroups = new Map<number, typeof muxSignals>();
          for (const signal of muxSignals) {
            const muxVal = signal.muxValue!;
            if (!muxGroups.has(muxVal)) {
              muxGroups.set(muxVal, []);
            }
            muxGroups.get(muxVal)!.push(signal);
          }

          // Sort mux groups by mux value
          const sortedMuxValues = Array.from(muxGroups.keys()).sort((a, b) => a - b);

          // Find signal definition for confidence color
          const findSignalDef = (name: string) => allSignals.find(s => s.name === name);

          // Render a single signal row
          const renderSignalRow = (decoded: DecodedSignal, idx: number, rowOffset: number) => {
            const signalDef = findSignalDef(decoded.name);
            const baseColour = colourForConfidence(signalDef?.confidence);
            const isHex = decoded.format === 'hex';
            const isBright = signalDef ? signalHasBrightBytes(signalDef) : false;
            const nameColor = getTextColour(baseColour, signalDef);
            const valueColor = getTextColour(baseColour, signalDef);
            const rowBg = isBright
              ? "bg-white/80 dark:bg-slate-700/80"
              : (idx + rowOffset) % 2 === 0
              ? "bg-slate-50 dark:bg-slate-900/40"
              : bgSurface;
            const timestampStr = formatSignalTimestamp(decoded.timestamp, displayTimeFormat, startTimeSeconds);

            return (
              <div
                key={`${decoded.muxValue ?? 'plain'}-${decoded.name}-${idx}`}
                className={`px-3 py-2 text-sm ${rowBg} flex items-center justify-between transition-colors duration-200`}
              >
                <div className="flex items-center gap-3">
                  {timestampStr && (
                    <span className={`${caption} font-mono w-20 shrink-0`}>
                      {timestampStr}
                    </span>
                  )}
                  <span
                    className="text-slate-800 dark:text-slate-100 transition-colors duration-200"
                    style={nameColor ? { color: nameColor } : undefined}
                  >
                    {decoded.name}
                  </span>
                </div>
                <div className={flexRowGap2}>
                  <span
                    className="font-mono transition-colors duration-200 text-slate-600 dark:text-slate-300"
                    style={valueColor ? { color: valueColor } : undefined}
                  >
                    {formatSignalValue(decoded)}
                  </span>
                  {isHex && (
                    <button
                      onClick={() => sendHexDataToCalculator(decoded.value.replace(/\s+/g, ''))}
                      className="p-0.5 rounded hover:bg-slate-200 dark:hover:bg-slate-700 transition-colors"
                      title="Send to Frame Calculator"
                    >
                      <Calculator className={`${iconXs} text-orange-600 dark:text-orange-400`} />
                    </button>
                  )}
                </div>
              </div>
            );
          };

          const hasContent = plainSignals.length > 0 || muxGroups.size > 0;

          if (!hasContent) {
            return (
              <div className={`px-3 py-2 ${caption}`}>
                No signals decoded yet.
              </div>
            );
          }

          let rowOffset = 0;

          return (
            <>
              {/* Plain signals (non-mux) */}
              {plainSignals.map((signal, idx) => renderSignalRow(signal, idx, rowOffset))}

              {/* Mux signal groups - each group has a header showing the mux value */}
              {sortedMuxValues.map((muxValue) => {
                const signals = muxGroups.get(muxValue)!;
                const muxValueHex = muxValue.toString(16).toUpperCase();
                rowOffset += plainSignals.length;

                return (
                  <div key={`mux-${muxValue}`}>
                    {/* Mux value header */}
                    <div className="px-3 py-1.5 text-xs bg-purple-50 dark:bg-purple-900/20 border-t border-slate-200 dark:border-slate-700 flex items-center gap-2">
                      <span className="text-purple-600 dark:text-purple-400">🔀</span>
                      <span className="font-medium text-purple-700 dark:text-purple-300">
                        Mux {muxValue}
                      </span>
                      <span className="text-purple-500 dark:text-purple-400 font-mono">
                        (0x{muxValueHex})
                      </span>
                    </div>
                    {/* Signals for this mux value */}
                    {signals.map((signal, idx) => renderSignalRow(signal, idx, rowOffset))}
                  </div>
                );
              })}
            </>
          );
        })()}
      </div>
    </div>
  );
}

export default function DecoderFramesView({
  frames,
  selectedIds,
  decoded,
  decodedPerSource,
  viewMode,
  displayFrameIdFormat,
  isDecoding,
  showRawBytes,
  onToggleRawBytes: _onToggleRawBytes, // Unused - moved to DecoderTopBar
  timestamp,
  displayTime,
  protocol = "can",
  serialConfig,
  unmatchedFrames = [],
  filteredFrames = [],
  isReady,
  playbackState,
  playbackDirection = "forward",
  capabilities,
  onPlay,
  onPlayBackward,
  onPause,
  onStepBackward,
  onStepForward,
  playbackSpeed = 1,
  onSpeedChange,
  hasBufferData = false,
  activeBookmarkId,
  onOpenBookmarkPicker,
  showTimeRange,
  onToggleTimeRange,
  startTime,
  endTime,
  onStartTimeChange,
  onEndTimeChange,
  minTimeUs,
  maxTimeUs,
  currentTimeUs,
  currentFrameIndex,
  totalFrames,
  onScrub,
  signalColours,
  headerFieldFilters,
  onToggleHeaderFieldFilter,
  onClearHeaderFieldFilter,
  seenHeaderFieldValues,
  hideUnseen = true,
  displayTimeFormat = "human",
  streamStartTimeSeconds,
  activeTab: activeTabProp = 'signals',
  onTabChange,
  showAsciiGutter = false,
  frameIdFilter: _frameIdFilter = '',
}: Props) {
  void _onToggleRawBytes; // Silence unused variable warning
  void _frameIdFilter; // Frame ID filtering is done at processing level in Decoder.tsx
  const selectedFrames = frames.filter((f) => selectedIds.has(f.id));

  // Use stream start time for delta-start calculation (passed from store)
  const startTimeSeconds = streamStartTimeSeconds ?? undefined;

  // Build protocol badges from serial config
  const protocolBadges = useMemo((): ProtocolBadge[] => {
    if (protocol !== 'serial') return [];

    const badges: ProtocolBadge[] = [];

    // Framing badge - show encoding or "None" if no framing configured
    if (serialConfig?.encoding) {
      const encodingLabel = serialConfig.encoding.toUpperCase();
      badges.push({ label: encodingLabel, color: 'blue' });
    } else {
      badges.push({ label: 'None', color: 'gray' });
    }

    // Header length badge
    if (serialConfig?.header_length && serialConfig.header_length > 0) {
      badges.push({ label: `${serialConfig.header_length}B hdr`, color: 'cyan' });
    }

    // Min frame length filter badge
    if (serialConfig?.min_frame_length && serialConfig.min_frame_length > 0) {
      badges.push({ label: `≥${serialConfig.min_frame_length}B`, color: 'purple' });
    }

    // Checksum badge
    if (serialConfig?.checksum?.algorithm) {
      badges.push({ label: serialConfig.checksum.algorithm.toUpperCase(), color: 'amber' });
    }

    return badges;
  }, [protocol, serialConfig]);

  // Build header field filter options from accumulated seen values (persists across frame updates)
  const headerFieldNames = useMemo(
    () => seenHeaderFieldValues ? Array.from(seenHeaderFieldValues.keys()).sort() : [],
    [seenHeaderFieldValues]
  );

  // Build options for each header field from accumulated values
  const headerFieldOptionsMap = useMemo(() => {
    const map = new Map<string, Array<{ value: number; display: string; count: number }>>();
    if (!seenHeaderFieldValues) return map;

    for (const [fieldName, valueMap] of seenHeaderFieldValues.entries()) {
      const options: Array<{ value: number; display: string; count: number }> = [];
      for (const [value, { display, count }] of valueMap.entries()) {
        options.push({ value, display, count });
      }
      // Sort by value
      options.sort((a, b) => a.value - b.value);
      map.set(fieldName, options);
    }
    return map;
  }, [seenHeaderFieldValues]);

  // Filter decoded frames based on header field filters
  const filteredDecoded = useMemo(() => {
    if (!headerFieldFilters || headerFieldFilters.size === 0) {
      return decoded;
    }

    const result = new Map<number, DecodedFrame>();
    for (const [frameId, frame] of decoded.entries()) {
      let passesFilter = true;

      for (const [fieldName, selectedValues] of headerFieldFilters.entries()) {
        if (selectedValues.size === 0) continue; // Empty = show all

        // Find this field in the frame's header fields
        const fieldValue = frame.headerFields.find(f => f.name === fieldName);
        if (!fieldValue || !selectedValues.has(fieldValue.value)) {
          passesFilter = false;
          break;
        }
      }

      if (passesFilter) {
        result.set(frameId, frame);
      }
    }

    return result;
  }, [decoded, headerFieldFilters]);

  const isPaused = playbackState === "paused";
  const supportsTimeRange = capabilities?.supports_time_range ?? false;
  const supportsSeek = capabilities?.supports_seek ?? false;
  const supportsSpeedControl = capabilities?.supports_speed_control ?? false;
  const supportsReverse = capabilities?.supports_reverse ?? false;
  const canPause = capabilities?.can_pause ?? false;
  const isBookmarkActive = !!activeBookmarkId;

  // Tab definitions - Signals tab always, plus Unmatched/Filtered tabs always visible
  // Show ">" prefix when buffer is at maximum capacity
  const tabs: TabDefinition[] = useMemo(() => {
    const unmatchedAtMax = unmatchedFrames.length >= MAX_UNMATCHED_FRAMES;
    const filteredAtMax = filteredFrames.length >= MAX_FILTERED_FRAMES;
    return [
      { id: 'signals', label: 'Signals', count: selectedFrames.length, countColor: 'green' as const },
      { id: 'unmatched', label: 'Unmatched', count: unmatchedFrames.length, countColor: 'orange' as const, countPrefix: unmatchedAtMax ? '>' : undefined },
      { id: 'filtered', label: 'Filtered', count: filteredFrames.length, countColor: 'purple' as const, countPrefix: filteredAtMax ? '>' : undefined },
    ];
  }, [selectedFrames.length, unmatchedFrames.length, filteredFrames.length]);

  // Track active tab - use prop if provided, otherwise local state
  const [localActiveTab, setLocalActiveTab] = useState<string>('signals');
  const activeTab = activeTabProp ?? localActiveTab;
  const setActiveTab = onTabChange ?? setLocalActiveTab;

  // Frame ID filtering is now done at the processing level in Decoder.tsx
  // The frameIdFilter prop is kept for potential future use but not used for view filtering

  // Convert byte to ASCII character (printable) or dot
  const byteToAscii = (b: number): string => {
    return b >= 0x20 && b <= 0x7E ? String.fromCharCode(b) : '.';
  };

  // Whether timeline should be shown
  const showTimeline = hasBufferData && minTimeUs != null && maxTimeUs != null && minTimeUs < maxTimeUs;

  // Tab bar controls (right side buttons)
  const tabBarControls = (
    <>
      {/* Time range toggle - only for PostgreSQL readers */}
      {supportsTimeRange && (
        <button
          type="button"
          onClick={onToggleTimeRange}
          className={`p-1.5 rounded transition-colors ${
            showTimeRange
              ? 'bg-blue-600 text-white hover:bg-blue-500'
              : 'bg-gray-700 text-gray-400 hover:bg-gray-600 hover:text-gray-200'
          }`}
          title={showTimeRange ? "Hide time range" : "Show time range"}
        >
          <Clock className={iconSm} />
        </button>
      )}
      {/* Bookmark picker - only for PostgreSQL readers */}
      {supportsTimeRange && onOpenBookmarkPicker && (
        <button
          type="button"
          onClick={onOpenBookmarkPicker}
          className={`p-1.5 rounded transition-colors ${
            isBookmarkActive
              ? 'bg-yellow-600 text-white hover:bg-yellow-500'
              : 'bg-gray-700 text-gray-400 hover:bg-gray-600 hover:text-gray-200'
          }`}
          title={isBookmarkActive ? "Bookmark loaded" : "Load bookmark"}
        >
          <Star
            className={iconSm}
            fill={isBookmarkActive ? "currentColor" : "none"}
          />
        </button>
      )}
    </>
  );

  // Time range inputs for toolbar (optional feature)
  const timeRangeInputs = showTimeRange && onStartTimeChange && onEndTimeChange ? (
    <div className={flexRowGap2}>
      <label className="text-xs text-gray-400">Start</label>
      <input
        type="datetime-local"
        value={startTime || ""}
        onChange={(e) => onStartTimeChange(e.target.value)}
        className="px-2 py-1 text-xs rounded border border-gray-600 bg-gray-900 text-gray-200"
      />
      <label className="text-xs text-gray-400 ml-2">End</label>
      <input
        type="datetime-local"
        value={endTime || ""}
        onChange={(e) => onEndTimeChange(e.target.value)}
        className="px-2 py-1 text-xs rounded border border-gray-600 bg-gray-900 text-gray-200"
      />
    </div>
  ) : null;

  // Playback controls for the toolbar center
  const playbackControls = (
    <PlaybackControls
      playbackState={playbackState}
      playbackDirection={playbackDirection}
      isReady={isReady}
      canPause={canPause}
      supportsSeek={supportsSeek}
      supportsSpeedControl={supportsSpeedControl}
      supportsReverse={supportsReverse}
      playbackSpeed={playbackSpeed}
      minTimeUs={minTimeUs}
      maxTimeUs={maxTimeUs}
      currentTimeUs={currentTimeUs}
      currentFrameIndex={currentFrameIndex}
      totalFrames={totalFrames}
      onPlay={onPlay}
      onPlayBackward={onPlayBackward}
      onPause={onPause}
      onStepBackward={onStepBackward}
      onStepForward={onStepForward}
      onScrub={onScrub}
      onSpeedChange={onSpeedChange}
    />
  );

  return (
    <AppTabView
      // Tab bar
      tabs={tabs}
      activeTab={activeTab}
      onTabChange={setActiveTab}
      protocolLabel={protocol.toUpperCase()}
      protocolBadges={protocolBadges}
      isStreaming={isDecoding && !isPaused}
      timestamp={timestamp}
      displayTime={displayTime ?? undefined}
      tabBarControls={tabBarControls}
      // Toolbar - show when we have time range or playback controls
      toolbar={
        showTimeRange || isReady
          ? {
              currentPage: 0,
              totalPages: 1,
              pageSize: -1,
              onPageChange: () => {},
              onPageSizeChange: () => {},
              leftContent: timeRangeInputs,
              centerContent: playbackControls,
              hidePagination: true,
            }
          : undefined
      }
      // Timeline
      timeline={
        showTimeline
          ? {
              minTimeUs: minTimeUs ?? 0,
              maxTimeUs: maxTimeUs ?? 0,
              currentTimeUs: currentTimeUs ?? minTimeUs ?? 0,
              onScrub: onScrub ?? (() => {}),
              displayTimeFormat: "human",
              disabled: !hasBufferData,
            }
          : undefined
      }
      // Content area with space-y-4 for card spacing
      contentArea={{ spaceY: true }}
    >
        {activeTab === 'signals' ? (
          // Signals tab content
          <>
            {/* Header field filters */}
            {headerFieldNames.length > 0 && onToggleHeaderFieldFilter && onClearHeaderFieldFilter && (
              <div className="flex flex-wrap items-center gap-4 pb-2 border-b border-slate-700">
                {headerFieldNames.map((fieldName) => {
                  const options = headerFieldOptionsMap.get(fieldName) ?? [];
                  const selected = headerFieldFilters?.get(fieldName) ?? new Set<number>();
                  return (
                    <HeaderFieldFilter
                      key={fieldName}
                      fieldName={fieldName}
                      options={options}
                      selectedValues={selected}
                      onToggle={(value) => onToggleHeaderFieldFilter(fieldName, value)}
                      onClear={() => onClearHeaderFieldFilter(fieldName)}
                      showCounts={true}
                      compact={false}
                    />
                  );
                })}
              </div>
            )}
            {viewMode === 'single' ? (
              // Single view: most recent message per frame ID
              // When hideUnseen is true, only show frames that have been decoded
              selectedFrames
                .filter((f) => !hideUnseen || filteredDecoded.has(f.id))
                .map((f) => (
                  <FrameCard
                    key={f.id}
                    frame={f}
                    decodedFrame={filteredDecoded.get(f.id)}
                    displayFrameIdFormat={displayFrameIdFormat}
                    showRawBytes={showRawBytes}
                    signalColours={signalColours}
                    serialConfig={serialConfig}
                    displayTimeFormat={displayTimeFormat}
                    onToggleHeaderFieldFilter={onToggleHeaderFieldFilter}
                    startTimeSeconds={startTimeSeconds}
                  />
                ))
            ) : (
              // Per-source view: separate section for each source address
              // When hideUnseen is true, only show frames that have been decoded
              selectedFrames
                .map((f) => {
                  // Find all source addresses for this frame ID
                  const sourceEntries: Array<{ sourceAddress: number; decodedFrame: DecodedFrame }> = [];
                  for (const [key, df] of decodedPerSource.entries()) {
                    const [frameIdStr, sourceAddrStr] = key.split(':');
                    const frameId = parseInt(frameIdStr, 10);
                    const sourceAddr = parseInt(sourceAddrStr, 10);
                    if (frameId === f.id && !isNaN(sourceAddr)) {
                      // Apply header field filter to per-source entries
                      let passesFilter = true;
                      if (headerFieldFilters && headerFieldFilters.size > 0) {
                        for (const [fieldName, selectedValues] of headerFieldFilters.entries()) {
                          if (selectedValues.size === 0) continue;
                          const fieldValue = df.headerFields.find(fld => fld.name === fieldName);
                          if (!fieldValue || !selectedValues.has(fieldValue.value)) {
                            passesFilter = false;
                            break;
                          }
                        }
                      }
                      if (passesFilter) {
                        sourceEntries.push({ sourceAddress: sourceAddr, decodedFrame: df });
                      }
                    }
                  }

                  // Sort by source address
                  sourceEntries.sort((a, b) => a.sourceAddress - b.sourceAddress);

                  // If no per-source data yet, fall back to single decoded entry (if it passes filter)
                  if (sourceEntries.length === 0) {
                    const singleDecoded = filteredDecoded.get(f.id);
                    if (singleDecoded) {
                      sourceEntries.push({
                        sourceAddress: singleDecoded.sourceAddress ?? 0,
                        decodedFrame: singleDecoded,
                      });
                    }
                  }

                  return { frame: f, sourceEntries };
                })
                .filter(({ sourceEntries }) => !hideUnseen || sourceEntries.length > 0)
                .map(({ frame: f, sourceEntries }) => (
                  <div key={f.id} className="space-y-2">
                    {sourceEntries.map(({ sourceAddress, decodedFrame }) => (
                      <FrameCard
                        key={`${f.id}:${sourceAddress}`}
                        frame={f}
                        decodedFrame={decodedFrame}
                        displayFrameIdFormat={displayFrameIdFormat}
                        showRawBytes={showRawBytes}
                        signalColours={signalColours}
                        sourceAddressLabel={sourceEntries.length > 1 || sourceAddress !== 0 ? sourceAddress : undefined}
                        serialConfig={serialConfig}
                        displayTimeFormat={displayTimeFormat}
                        onToggleHeaderFieldFilter={onToggleHeaderFieldFilter}
                        startTimeSeconds={startTimeSeconds}
                      />
                    ))}
                  </div>
                ))
            )}
            {selectedFrames.length === 0 && (
              <div className="text-sm text-gray-500">No frames selected.</div>
            )}
          </>
        ) : activeTab === 'unmatched' ? (
          // Unmatched frames tab content - timestamped list of raw frames
          <div className="space-y-1">
            {unmatchedFrames.length === 0 ? (
              <div className="text-sm text-gray-500">No unmatched frames.</div>
            ) : (
              unmatchedFrames.slice(-100).reverse().map((frame, idx) => {
                const date = new Date(frame.timestamp * 1000);
                const timeStr = date.toLocaleTimeString('en-US', {
                  hour12: false,
                  hour: '2-digit',
                  minute: '2-digit',
                  second: '2-digit',
                }) + '.' + String(date.getMilliseconds()).padStart(3, '0');
                const isExtended = frame.frameId > 0x7FF;
                const idStr = formatFrameId(frame.frameId, displayFrameIdFormat, isExtended);
                const bytesHex = frame.bytes.map(b => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');
                const asciiStr = frame.bytes.map(byteToAscii).join('');
                return (
                  <div
                    key={`${frame.timestamp}-${frame.frameId}-${idx}`}
                    className="flex items-center gap-3 px-3 py-1.5 bg-gray-800 rounded text-sm font-mono"
                  >
                    <span className="text-gray-500 text-xs">{timeStr}</span>
                    <span className="text-purple-400 font-semibold">{idStr}</span>
                    {frame.sourceAddress !== undefined && (
                      <span className="text-cyan-400 text-xs">src: 0x{frame.sourceAddress.toString(16).toUpperCase()}</span>
                    )}
                    <span className="text-gray-500 text-xs">[{frame.bytes.length}]</span>
                    <span className="text-gray-300 flex-1">{bytesHex}</span>
                    {showAsciiGutter && (
                      <span className="text-yellow-400 text-xs font-mono">{asciiStr}</span>
                    )}
                    <button
                      onClick={() => sendHexDataToCalculator(bytesHex.replace(/\s+/g, ''))}
                      className="p-1 rounded hover:bg-gray-700 transition-colors"
                      title="Send to Frame Calculator"
                    >
                      <Calculator className={`${iconSm} text-orange-400`} />
                    </button>
                  </div>
                );
              })
            )}
          </div>
        ) : activeTab === 'filtered' ? (
          // Filtered frames tab content - frames filtered by length or ID
          <div className="space-y-1">
            {filteredFrames.length === 0 ? (
              <div className="text-sm text-gray-500">No filtered frames.</div>
            ) : (
              filteredFrames.slice(-100).reverse().map((frame, idx) => {
                const date = new Date(frame.timestamp * 1000);
                const timeStr = date.toLocaleTimeString('en-US', {
                  hour12: false,
                  hour: '2-digit',
                  minute: '2-digit',
                  second: '2-digit',
                }) + '.' + String(date.getMilliseconds()).padStart(3, '0');
                const isExtended = frame.frameId > 0x7FF;
                const idStr = formatFrameId(frame.frameId, displayFrameIdFormat, isExtended);
                const bytesHex = frame.bytes.map(b => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');
                const asciiStr = frame.bytes.map(byteToAscii).join('');
                return (
                  <div
                    key={`${frame.timestamp}-${frame.frameId}-${idx}`}
                    className="flex items-center gap-3 px-3 py-1.5 bg-gray-800 rounded text-sm font-mono"
                  >
                    <span className="text-gray-500 text-xs">{timeStr}</span>
                    <span className="text-purple-400 font-semibold">{idStr}</span>
                    {frame.sourceAddress !== undefined && (
                      <span className="text-cyan-400 text-xs">src: 0x{frame.sourceAddress.toString(16).toUpperCase()}</span>
                    )}
                    <span className="text-gray-500 text-xs">[{frame.bytes.length}]</span>
                    <span className="text-gray-300 flex-1">{bytesHex}</span>
                    {showAsciiGutter && (
                      <span className="text-yellow-400 text-xs font-mono">{asciiStr}</span>
                    )}
                    <span className="text-amber-400 text-xs">
                      {frame.reason === 'id_filter' ? 'ID filter' : 'too short'}
                    </span>
                    <button
                      onClick={() => sendHexDataToCalculator(bytesHex.replace(/\s+/g, ''))}
                      className="p-1 rounded hover:bg-gray-700 transition-colors"
                      title="Send to Frame Calculator"
                    >
                      <Calculator className={`${iconSm} text-orange-400`} />
                    </button>
                  </div>
                );
              })
            )}
          </div>
        ) : null}
    </AppTabView>
  );
}
