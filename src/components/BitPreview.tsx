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
const DEFAULT_MAX_HEIGHT = 400;

interface ScalingResult {
  scale: number;
  bytesPerRow: number;
  bitHeight: number;
  bitWidth: number;
  fontSize: number;
  gap: number;
}

/**
 * Calculate optimal scaling for BitPreview based on byte count.
 * Returns scale factor, bytes per row, and computed dimensions.
 */
function calculateScaling(numBytes: number, maxHeight: number): ScalingResult {
  // For small frames (1-8 bytes), use full size, 1 byte per row
  if (numBytes <= 8) {
    return {
      scale: 1,
      bytesPerRow: 1,
      bitHeight: BASE_BIT_HEIGHT,
      bitWidth: BASE_BIT_WIDTH,
      fontSize: 12,
      gap: 4,
    };
  }

  // Row height includes bit height + gap
  const rowGap = 8;

  // For medium frames (9-32 bytes), scale down but keep 1 byte per row
  if (numBytes <= 32) {
    const totalHeight = numBytes * (BASE_BIT_HEIGHT + rowGap);
    const scale = Math.min(1, maxHeight / totalHeight);
    const clampedScale = Math.max(scale, MIN_BIT_HEIGHT / BASE_BIT_HEIGHT);
    return {
      scale: clampedScale,
      bytesPerRow: 1,
      bitHeight: Math.round(BASE_BIT_HEIGHT * clampedScale),
      bitWidth: Math.round(BASE_BIT_WIDTH * clampedScale),
      fontSize: Math.max(8, Math.round(12 * clampedScale)),
      gap: Math.max(2, Math.round(4 * clampedScale)),
    };
  }

  // For large frames (33+ bytes), use multi-column layout
  // 2 bytes/row for 33-64, 4 bytes/row for 65-128, 8 bytes/row for 129+
  let bytesPerRow: number;
  if (numBytes <= 64) {
    bytesPerRow = 2;
  } else if (numBytes <= 128) {
    bytesPerRow = 4;
  } else {
    bytesPerRow = 8;
  }

  const rows = Math.ceil(numBytes / bytesPerRow);
  const targetRowHeight = maxHeight / rows;
  const scale = Math.min(1, targetRowHeight / (BASE_BIT_HEIGHT + rowGap));
  const clampedScale = Math.max(scale, MIN_BIT_HEIGHT / BASE_BIT_HEIGHT);

  return {
    scale: clampedScale,
    bytesPerRow,
    bitHeight: Math.round(BASE_BIT_HEIGHT * clampedScale),
    bitWidth: Math.round(BASE_BIT_WIDTH * clampedScale),
    fontSize: Math.max(8, Math.round(12 * clampedScale)),
    gap: Math.max(2, Math.round(4 * clampedScale)),
  };
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

  // Calculate scaling based on byte count and max height
  const scaling = useMemo(() => {
    const result = calculateScaling(numBytes, compact ? maxHeight * 0.5 : maxHeight);
    if (bytesPerRowOverride !== undefined) {
      return { ...result, bytesPerRow: bytesPerRowOverride };
    }
    return result;
  }, [numBytes, maxHeight, compact, bytesPerRowOverride]);

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
          className="font-mono text-[color:var(--text-muted)] shrink-0"
          style={{ fontSize: `${scaling.fontSize}px`, width: scaling.bytesPerRow > 1 ? '36px' : '50px' }}
        >
          {scaling.bytesPerRow > 1 ? `${byteIdx}:` : `Byte ${byteIdx}:`}
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
            className="font-mono text-[color:var(--text-muted)] shrink-0 text-right"
            style={{ fontSize: `${scaling.fontSize}px`, width: '40px' }}
          >
            {startBit}-{endBit - 1}
          </div>
        )}
      </div>
    );
  };

  return (
    <div
      className="select-none"
      style={{ display: 'flex', flexDirection: 'column', gap: `${scaling.gap * 2}px` }}
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
          style={{ gap: `${scaling.gap * 2}px` }}
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
