import { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import { useSettings } from '../hooks/useSettings';
import { flexRowGap2 } from '../styles/spacing';

export interface BitRange {
  name: string;
  start_bit: number;
  bit_length: number;
  type?: 'signal' | 'mux' | 'current';
}

// Base dimensions for bit squares (in pixels)
const BASE_BIT_HEIGHT = 32;
const BASE_BIT_WIDTH = 40;
const MIN_BIT_HEIGHT = 16;
const MIN_BIT_WIDTH = 20;
const DEFAULT_MAX_HEIGHT = 400;

// Full-size label widths
const BASE_LABEL_WIDTH = 22;      // byte index badge
const BASE_LABEL_WIDTH_MULTI = 22; // byte index badge (multi-column)
const BASE_RANGE_WIDTH = 40;      // "0-7"

interface ScalingResult {
  scale: number;
  bytesPerRow: number;
  bitHeight: number;
  bitWidth: number;
  fontSize: number;
  gap: number;
  labelWidth: number;
  rangeWidth: number;
}

/**
 * Compute the actual rendered row width from pixel-snapped ScalingResult values.
 */
function computeRenderedRowWidth(s: ScalingResult): number {
  const bitGap = Math.max(1, s.gap / 2);
  if (s.bytesPerRow === 1) {
    return s.labelWidth + s.gap + 8 * s.bitWidth + 7 * bitGap + s.gap + s.rangeWidth;
  }
  const perByte = s.labelWidth + s.gap + 8 * s.bitWidth + 7 * bitGap;
  return s.bytesPerRow * perByte + (s.bytesPerRow - 1) * s.gap * 2;
}

/**
 * Compute the full-size row width (all elements at scale 1) for a given bytesPerRow.
 */
function computeFullRowWidth(bytesPerRow: number): number {
  const gap = 4;
  const bitGap = 2;
  if (bytesPerRow === 1) {
    return BASE_LABEL_WIDTH + gap + 8 * BASE_BIT_WIDTH + 7 * bitGap + gap + BASE_RANGE_WIDTH;
  }
  const perByte = BASE_LABEL_WIDTH_MULTI + gap + 8 * BASE_BIT_WIDTH + 7 * bitGap;
  return bytesPerRow * perByte + (bytesPerRow - 1) * gap * 2;
}

/**
 * Apply a uniform scale to all dimensions and return a ScalingResult.
 */
function applyScale(s: number, bytesPerRow: number): ScalingResult {
  return {
    scale: s,
    bytesPerRow,
    bitHeight: Math.max(MIN_BIT_HEIGHT, Math.floor(BASE_BIT_HEIGHT * s)),
    bitWidth: Math.max(MIN_BIT_WIDTH, Math.floor(BASE_BIT_WIDTH * s)),
    fontSize: Math.max(8, Math.round(12 * s)),
    gap: Math.max(2, Math.round(4 * s)),
    labelWidth: Math.floor((bytesPerRow > 1 ? BASE_LABEL_WIDTH_MULTI : BASE_LABEL_WIDTH) * s),
    rangeWidth: Math.floor(BASE_RANGE_WIDTH * s),
  };
}

/**
 * Calculate optimal scaling for BitPreview based on byte count and available space.
 * Returns scale factor, bytes per row, and computed dimensions.
 */
function calculateScaling(numBytes: number, maxHeight: number, containerWidth?: number): ScalingResult {
  let heightScale: number;
  let bytesPerRow: number;

  if (numBytes <= 8) {
    heightScale = 1;
    bytesPerRow = 1;
  } else if (numBytes <= 32) {
    const rowGap = 8;
    const totalHeight = numBytes * (BASE_BIT_HEIGHT + rowGap);
    heightScale = Math.max(MIN_BIT_HEIGHT / BASE_BIT_HEIGHT, Math.min(1, maxHeight / totalHeight));
    bytesPerRow = 1;
  } else {
    if (numBytes <= 64) {
      bytesPerRow = 2;
    } else if (numBytes <= 128) {
      bytesPerRow = 4;
    } else {
      bytesPerRow = 8;
    }
    const rowGap = 8;
    const rows = Math.ceil(numBytes / bytesPerRow);
    const targetRowHeight = maxHeight / rows;
    heightScale = Math.max(MIN_BIT_HEIGHT / BASE_BIT_HEIGHT, Math.min(1, targetRowHeight / (BASE_BIT_HEIGHT + rowGap)));
  }

  // Width-based scale: shrink all elements uniformly to fit container
  let widthScale = 1;
  if (containerWidth != null && containerWidth > 0) {
    const fullWidth = computeFullRowWidth(bytesPerRow);
    if (fullWidth > containerWidth) {
      widthScale = containerWidth / fullWidth;
    }
  }

  const finalScale = Math.max(MIN_BIT_WIDTH / BASE_BIT_WIDTH, Math.min(heightScale, widthScale));
  const result = applyScale(finalScale, bytesPerRow);

  // Pixel-perfect adjustment: rounding can cause the rendered row to exceed
  // the container by a few pixels. Shave off bit width until it fits.
  if (containerWidth != null && containerWidth > 0) {
    while (computeRenderedRowWidth(result) > containerWidth && result.bitWidth > MIN_BIT_WIDTH) {
      result.bitWidth -= 1;
      result.bitHeight = Math.max(MIN_BIT_HEIGHT, Math.floor(BASE_BIT_HEIGHT * (result.bitWidth / BASE_BIT_WIDTH)));
    }
  }

  return result;
}

interface BitPreviewProps {
  numBytes: number;
  ranges: BitRange[];
  currentStartBit?: number;
  currentBitLength?: number;
  interactive?: boolean;
  showLegend?: boolean;
  onColorMapping?: (lookup: (range: BitRange) => string | undefined) => void;
  onRangeSelect?: (startBit: number, bitLength: number) => void;
  /** Custom colour for available (zero) bits - hex colour string */
  binaryZeroColour?: string;
  /** Target max height for the preview (default: 400px) */
  maxHeight?: number;
  /** Force compact mode regardless of byte count */
  compact?: boolean;
  /** Override auto-calculated bytes per row */
  bytesPerRowOverride?: number;
}

export default function BitPreview({
  numBytes,
  ranges,
  currentStartBit = 0,
  currentBitLength = 0,
  interactive = false,
  showLegend = true,
  onColorMapping,
  onRangeSelect,
  binaryZeroColour: binaryZeroColourProp,
  maxHeight = DEFAULT_MAX_HEIGHT,
  compact = false,
  bytesPerRowOverride,
}: BitPreviewProps) {
  const { settings } = useSettings();
  // Use prop if provided, otherwise fall back to settings, then default
  const binaryZeroColour = binaryZeroColourProp ?? settings?.binary_zero_colour ?? "#94a3b8";

  // Measure container width so we can shrink bit cells to fit
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState<number | undefined>(undefined);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const w = entry.contentRect.width;
        if (w > 0) setContainerWidth(w);
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Calculate scaling based on byte count, max height, and available width
  const scaling = useMemo(() => {
    const result = calculateScaling(numBytes, compact ? maxHeight * 0.5 : maxHeight, containerWidth);
    if (bytesPerRowOverride !== undefined) {
      return { ...result, bytesPerRow: bytesPerRowOverride };
    }
    return result;
  }, [numBytes, maxHeight, compact, bytesPerRowOverride, containerWidth]);

  const [dragStart, setDragStart] = useState<number | null>(null);
  const [dragEnd, setDragEnd] = useState<number | null>(null);
  const [isMouseDown, setIsMouseDown] = useState(false);

  const { colorByKey, legendEntries } = useMemo(() => {
    // Stick to cool blues/teals so claimed bits share a family of colours (avoid red except for overlaps).
    const signalPalette = [
      "bg-[var(--signal-blue-1)]",
      "bg-[var(--signal-blue-2)]",
      "bg-[var(--signal-blue-3)]",
      "bg-[var(--signal-blue-4)]",
      "bg-[var(--signal-sky-1)]",
      "bg-[var(--signal-sky-2)]",
      "bg-[var(--signal-cyan-1)]",
      "bg-[var(--signal-cyan-2)]",
      "bg-[var(--signal-teal-1)]",
      "bg-[var(--signal-teal-2)]",
    ];

    const muxPalette = [
      "bg-[var(--signal-purple-1)]",
      "bg-[var(--signal-violet-1)]",
      "bg-[var(--signal-fuchsia-1)]",
    ];

    const makeKey = (r: BitRange) =>
      `${r.type || "signal"}|${r.name ?? ""}|${r.start_bit}|${r.bit_length}`;

    const map = new Map<string, string>();
    const legend: { key: string; label: string; className: string }[] = [];
    let signalIdx = 0;
    let muxIdx = 0;

    ranges.forEach((r) => {
      const key = makeKey(r);
      if (map.has(key)) return;

      let className: string;
      if (r.type === "mux") {
        className = muxPalette[muxIdx % muxPalette.length];
        muxIdx += 1;
      } else {
        className = signalPalette[signalIdx % signalPalette.length];
        signalIdx += 1;
      }

      map.set(key, className);
      legend.push({
        key,
        label: r.name || (r.type === "mux" ? "Mux selector" : "Signal"),
        className,
      });
    });

    return { colorByKey: map, legendEntries: legend };
  }, [ranges]);

  // Use a ref to store onColorMapping to avoid infinite loops when parent passes
  // an inline function. We only want to call it when colorByKey actually changes.
  const onColorMappingRef = useRef(onColorMapping);
  onColorMappingRef.current = onColorMapping;

  useEffect(() => {
    if (onColorMappingRef.current) {
      onColorMappingRef.current((range) => colorByKey.get(`${range.type || "signal"}|${range.name ?? ""}|${range.start_bit}|${range.bit_length}`));
    }
  }, [colorByKey]);

  const handleMouseDown = useCallback((bitIdx: number, event: React.MouseEvent) => {
    if (!interactive) return;
    event.preventDefault(); // Prevent text selection
    setIsMouseDown(true);
    setDragStart(bitIdx);
    setDragEnd(bitIdx);
  }, [interactive]);

  const handleMouseEnter = useCallback((bitIdx: number) => {
    if (!interactive || !isMouseDown) return;
    setDragEnd(bitIdx);
  }, [interactive, isMouseDown]);

  const handleMouseUp = useCallback(() => {
    if (!interactive || !isMouseDown || dragStart === null || dragEnd === null) return;

    setIsMouseDown(false);

    // Calculate start bit and length from drag
    const start = Math.min(dragStart, dragEnd);
    const end = Math.max(dragStart, dragEnd);
    const length = end - start + 1;

    if (onRangeSelect) {
      onRangeSelect(start, length);
    }

    setDragStart(null);
    setDragEnd(null);
  }, [interactive, isMouseDown, dragStart, dragEnd, onRangeSelect]);

  // Group bytes into rows based on bytesPerRow
  const byteRows = useMemo(() => {
    const rows: number[][] = [];
    for (let i = 0; i < numBytes; i += scaling.bytesPerRow) {
      const row: number[] = [];
      for (let j = 0; j < scaling.bytesPerRow && i + j < numBytes; j++) {
        row.push(i + j);
      }
      rows.push(row);
    }
    return rows;
  }, [numBytes, scaling.bytesPerRow]);

  const hasOverlap = useMemo(() => {
    // Check overlaps between ranges
    for (let i = 0; i < ranges.length; i++) {
      const a = ranges[i];
      const aStart = a.start_bit;
      const aEnd = a.start_bit + a.bit_length;
      for (let j = i + 1; j < ranges.length; j++) {
        const b = ranges[j];
        const bStart = b.start_bit;
        const bEnd = b.start_bit + b.bit_length;
        if (Math.max(aStart, bStart) < Math.min(aEnd, bEnd)) {
          return true;
        }
      }
    }
    // Also consider overlap between current selection and any range
    if (currentBitLength > 0) {
      const curStart = currentStartBit;
      const curEnd = currentStartBit + currentBitLength;
      for (const r of ranges) {
        const rStart = r.start_bit;
        const rEnd = r.start_bit + r.bit_length;
        if (Math.max(curStart, rStart) < Math.min(curEnd, rEnd)) {
          return true;
        }
      }
    }
    return false;
  }, [ranges, currentStartBit, currentBitLength]);

  // Helper to render a single byte
  const renderByte = (byteIdx: number) => {
    const startBit = byteIdx * 8;
    const endBit = startBit + 8;

    return (
      <div key={byteIdx} className="flex items-center" style={{ gap: `${scaling.gap}px` }}>
        <div
          className="font-mono text-[color:var(--text-muted)] shrink-0 flex items-center justify-center rounded bg-[var(--bg-muted)]"
          style={{ fontSize: `${scaling.fontSize}px`, width: `${scaling.labelWidth}px`, height: `${scaling.bitHeight}px` }}
        >
          {byteIdx}
        </div>

        <div className="flex" style={{ gap: `${Math.max(1, scaling.gap / 2)}px` }}>
          {Array.from({ length: 8 }).map((_, bitInByte) => {
            // Bits are displayed high to low (left to right), so reverse the index
            const bitIdx = endBit - 1 - bitInByte;

            // Check if this bit is in drag selection
            const isDragSelected = dragStart !== null && dragEnd !== null &&
              bitIdx >= Math.min(dragStart, dragEnd) &&
              bitIdx <= Math.max(dragStart, dragEnd);

            // Find which range occupies this bit
            let rangeAtBit: BitRange | undefined;
            let rangeType: 'current' | 'mux' | 'signal' | 'available' = 'available';

            // Check current range first
            if (bitIdx >= currentStartBit && bitIdx < currentStartBit + currentBitLength) {
              rangeType = 'current';
            } else {
              // Check other ranges
              rangeAtBit = ranges.find(r => {
                const start = r.start_bit;
                const end = start + r.bit_length;
                return bitIdx >= start && bitIdx < end;
              });

              if (rangeAtBit) {
                rangeType = rangeAtBit.type || 'signal';
              }
            }

            // Check for overlap (multiple ranges claiming the same bit)
            const overlappingRanges = ranges.filter(r => {
              const start = r.start_bit;
              const end = start + r.bit_length;
              return bitIdx >= start && bitIdx < end;
            });

            const currentOverlaps = bitIdx >= currentStartBit && bitIdx < currentStartBit + currentBitLength;
            const isOverlap = (currentOverlaps && overlappingRanges.length > 0) || overlappingRanges.length > 1;

            const rangeKey =
              rangeAtBit && colorByKey.size > 0
                ? `${rangeAtBit.type || "signal"}|${rangeAtBit.name ?? ""}|${rangeAtBit.start_bit}|${rangeAtBit.bit_length}`
                : null;
            const rangeColorClass = rangeKey ? colorByKey.get(rangeKey) : undefined;

            // Available bit style - use custom colour if provided, otherwise default grey
            const availableStyle = binaryZeroColour
              ? { backgroundColor: binaryZeroColour }
              : undefined;
            const availableClass = binaryZeroColour
              ? ''
              : 'bg-[var(--bg-muted)] border border-[color:var(--border-default)]';

            const bgColor = isDragSelected
              ? 'bg-[var(--status-warning)]'
              : isOverlap
              ? 'bg-red-500'
              : rangeType === 'current'
              ? 'bg-[var(--status-success)]'
              : rangeColorClass
              ? rangeColorClass
              : availableClass;

            const overlappingNames = overlappingRanges.map(r => r.name || (r.type === "mux" ? "Mux" : "Signal"));

            const tooltip = isDragSelected
              ? `Selecting bit ${bitIdx}`
              : isOverlap
              ? `OVERLAP: ${overlappingNames.join(", ")}`
              : rangeType === 'current'
              ? `Bit ${bitIdx} (current)`
              : rangeAtBit
              ? `Bit ${bitIdx}: ${rangeAtBit.name || "Signal"}`
              : `Bit ${bitIdx} (available)`;

            // Only apply custom style for available bits (when no other styling applies)
            const useCustomStyle = availableStyle && !isDragSelected && !isOverlap && rangeType !== 'current' && !rangeColorClass;

            // Show bit number only for larger sizes
            const showBitNumber = scaling.bitWidth >= 24;

            return (
              <div
                key={bitInByte}
                className={`flex items-center justify-center ${bgColor} shrink-0 ${
                  interactive ? 'cursor-pointer select-none' : ''
                }`}
                style={{
                  height: `${scaling.bitHeight}px`,
                  width: `${scaling.bitWidth}px`,
                  ...(useCustomStyle ? availableStyle : {}),
                }}
                title={tooltip}
                onMouseDown={(e) => handleMouseDown(bitIdx, e)}
                onMouseEnter={() => handleMouseEnter(bitIdx)}
              >
                {showBitNumber && (
                  <span className="font-medium text-white" style={{ fontSize: `${scaling.fontSize}px` }}>
                    {bitIdx}
                  </span>
                )}
              </div>
            );
          })}
        </div>

        {scaling.bytesPerRow === 1 && (
          <div
            className="font-mono text-[color:var(--text-muted)] shrink-0 text-right overflow-hidden"
            style={{ fontSize: `${scaling.fontSize}px`, width: `${scaling.rangeWidth}px` }}
          >
            {startBit}-{endBit - 1}
          </div>
        )}
      </div>
    );
  };

  return (
    <div
      ref={containerRef}
      className="select-none overflow-hidden"
      style={{ display: 'flex', flexDirection: 'column', gap: `${scaling.gap}px` }}
      onMouseUp={handleMouseUp}
      onMouseLeave={() => {
        if (isMouseDown) {
          handleMouseUp();
        }
      }}
    >
      {byteRows.map((bytesInRow, rowIdx) => (
        <div
          key={rowIdx}
          className="flex flex-wrap items-center"
          style={{ gap: `${scaling.gap}px` }}
        >
          {bytesInRow.map(byteIdx => renderByte(byteIdx))}
        </div>
      ))}

      <div className="mt-4 space-y-2 text-xs">
        {hasOverlap && (
          <div className={flexRowGap2}>
            <div className="w-4 h-4 bg-red-500 rounded" />
            <span className="text-[color:var(--text-secondary)]">Overlap (error!)</span>
          </div>
        )}

        {interactive && (
          <div className={flexRowGap2}>
            <div className="w-4 h-4 bg-[var(--status-warning)] rounded" />
            <span className="text-[color:var(--text-secondary)]">Click and drag to select</span>
          </div>
        )}

        {showLegend && legendEntries.length > 0 && (
          <div className="flex flex-wrap gap-3 pt-1">
            {legendEntries.map((entry) => (
              <div key={entry.key} className="flex items-center gap-1">
                <div className={`w-4 h-4 rounded ${entry.className}`} />
                <span className="text-[color:var(--text-secondary)]">
                  {entry.label}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
