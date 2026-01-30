// ui/src/components/MaskBitPicker.tsx
// Graphical bit picker for ID mask selection
// Supports arbitrary byte sizes for CAN (4 bytes) and serial (variable) IDs
// Allows drag selection to define mask and auto-calculates shift

import { useState, useCallback, useMemo, useEffect } from 'react';
import { flexRowGap2 } from '../styles/spacing';
import { caption, captionMuted, sectionHeaderText } from '../styles/typography';

interface MaskBitPickerProps {
  /** Current mask value (as number) */
  mask: number;
  /** Current shift value */
  shift: number;
  /** Callback when mask/shift changes via drag selection */
  onMaskChange: (mask: number, shift: number) => void;
  /** Number of bytes in the ID (default: 4 for CAN, can be 1-8 for serial) */
  numBytes?: number;
  /** Number of active bits (for CAN: 11 standard, 29 extended; for serial: numBytes * 8) */
  activeBits?: number;
  /** Optional label */
  label?: string;
}

// Bit dimensions
const BIT_SIZE = 20;
const BIT_GAP = 1;

export default function MaskBitPicker({
  mask,
  shift,
  onMaskChange,
  numBytes = 4,
  activeBits,
  label,
}: MaskBitPickerProps) {
  // Calculate total bits and active bits
  const totalBits = numBytes * 8;
  const numActiveBits = activeBits ?? totalBits;
  const [dragStart, setDragStart] = useState<number | null>(null);
  const [dragEnd, setDragEnd] = useState<number | null>(null);
  const [isMouseDown, setIsMouseDown] = useState(false);

  // Calculate which bits are selected based on mask and shift
  const selectedBits = useMemo(() => {
    const bits = new Set<number>();
    // Shift the mask left by shift amount to get original bit positions
    const shiftedMask = mask << shift;
    for (let i = 0; i < 32; i++) {
      if ((shiftedMask >>> i) & 1) {
        bits.add(i);
      }
    }
    return bits;
  }, [mask, shift]);

  // Get the contiguous range from selected bits
  const selectedRange = useMemo(() => {
    if (selectedBits.size === 0) return null;
    const sorted = Array.from(selectedBits).sort((a, b) => a - b);
    return { start: sorted[0], end: sorted[sorted.length - 1] };
  }, [selectedBits]);

  const handleMouseDown = useCallback((bitIdx: number, event: React.MouseEvent) => {
    event.preventDefault();
    setIsMouseDown(true);
    setDragStart(bitIdx);
    setDragEnd(bitIdx);
  }, []);

  const handleMouseEnter = useCallback((bitIdx: number) => {
    if (!isMouseDown) return;
    setDragEnd(bitIdx);
  }, [isMouseDown]);

  const handleMouseUp = useCallback(() => {
    if (!isMouseDown || dragStart === null || dragEnd === null) return;

    setIsMouseDown(false);

    // Calculate start bit and length from drag
    const start = Math.min(dragStart, dragEnd);
    const end = Math.max(dragStart, dragEnd);
    const length = end - start + 1;

    // Create mask: a contiguous run of 1s of the given length, shifted to position
    // For example: start=0, length=8 -> mask=0xFF, shift=0
    // start=8, length=8 -> mask=0xFF, shift=8
    const newMask = ((1 << length) - 1) >>> 0; // Mask of 'length' ones
    const newShift = start;

    onMaskChange(newMask, newShift);

    setDragStart(null);
    setDragEnd(null);
  }, [isMouseDown, dragStart, dragEnd, onMaskChange]);

  // Handle mouse up outside the component
  useEffect(() => {
    const handleGlobalMouseUp = () => {
      if (isMouseDown) {
        handleMouseUp();
      }
    };
    window.addEventListener('mouseup', handleGlobalMouseUp);
    return () => window.removeEventListener('mouseup', handleGlobalMouseUp);
  }, [isMouseDown, handleMouseUp]);

  // Render bits in groups of 8 (bytes), high bit on left
  const renderBitRow = (startBit: number, endBit: number, rowLabel: string) => {
    const bits = [];

    // Iterate from high bit to low bit (left to right display)
    for (let bitIdx = endBit - 1; bitIdx >= startBit; bitIdx--) {
      const isDragSelected = dragStart !== null && dragEnd !== null &&
        bitIdx >= Math.min(dragStart, dragEnd) &&
        bitIdx <= Math.max(dragStart, dragEnd);

      const isSelected = selectedBits.has(bitIdx);
      const isOutOfRange = bitIdx >= numActiveBits;

      let bgColor: string;
      if (isOutOfRange) {
        bgColor = 'bg-[var(--bg-tertiary)] opacity-30';
      } else if (isDragSelected) {
        bgColor = 'bg-[var(--text-yellow)]';
      } else if (isSelected) {
        bgColor = 'bg-[var(--accent-primary)]';
      } else {
        bgColor = 'bg-[var(--bg-tertiary)] hover:bg-[var(--hover-bg)]';
      }

      const tooltip = isOutOfRange
        ? `Bit ${bitIdx} (not used in ${numActiveBits}-bit ID)`
        : isDragSelected
        ? `Selecting bit ${bitIdx}`
        : isSelected
        ? `Bit ${bitIdx} (in mask)`
        : `Bit ${bitIdx}`;

      bits.push(
        <div
          key={bitIdx}
          className={`flex items-center justify-center ${bgColor} cursor-pointer select-none transition-colors text-xs font-mono ${
            isOutOfRange ? 'cursor-not-allowed' : ''
          }`}
          style={{
            width: `${BIT_SIZE}px`,
            height: `${BIT_SIZE}px`,
          }}
          title={tooltip}
          onMouseDown={(e) => !isOutOfRange && handleMouseDown(bitIdx, e)}
          onMouseEnter={() => !isOutOfRange && handleMouseEnter(bitIdx)}
        >
          <span className={`text-[9px] ${isSelected || isDragSelected ? 'text-white' : 'text-[color:var(--text-secondary)]'}`}>
            {bitIdx}
          </span>
        </div>
      );
    }

    return (
      <div key={rowLabel} className={flexRowGap2}>
        <span className={`${caption} w-16 text-right font-mono`}>
          {rowLabel}
        </span>
        <div className="flex" style={{ gap: `${BIT_GAP}px` }}>
          {bits}
        </div>
      </div>
    );
  };

  // Display current mask/shift info
  const hexDigits = numBytes * 2;
  const maskHex = `0x${(mask << shift).toString(16).toUpperCase().padStart(hexDigits, '0')}`;
  const extractedBits = selectedRange
    ? `bits ${selectedRange.start}-${selectedRange.end} (${selectedRange.end - selectedRange.start + 1} bits)`
    : 'none';

  return (
    <div className="space-y-2">
      {label && (
        <label className={`block ${sectionHeaderText}`}>
          {label}
        </label>
      )}

      <div
        className="inline-block p-3 bg-[var(--bg-surface)] rounded-lg"
        onMouseLeave={() => {
          if (isMouseDown) {
            handleMouseUp();
          }
        }}
      >
        <div className="space-y-1">
          {/* Render rows of 8 bits each, from high byte to low byte */}
          {Array.from({ length: numBytes }, (_, rowIdx) => {
            const byteIdx = numBytes - 1 - rowIdx; // High byte first
            const startBit = byteIdx * 8;
            const endBit = startBit + 8;
            const label = numBytes <= 4
              ? `bits ${endBit - 1}-${startBit}`
              : `byte ${byteIdx}`;
            return renderBitRow(startBit, endBit, label);
          })}
        </div>

        <div className="mt-3 pt-2 border-t border-[color:var(--border-default)] space-y-1">
          <div className="flex items-center gap-4 text-xs">
            <div className={flexRowGap2}>
              <div className="w-3 h-3 bg-[var(--accent-primary)] rounded-sm" />
              <span className="text-[color:var(--text-muted)]">Selected</span>
            </div>
            <div className={flexRowGap2}>
              <div className="w-3 h-3 bg-[var(--text-yellow)] rounded-sm" />
              <span className="text-[color:var(--text-muted)]">Dragging</span>
            </div>
          </div>

          <p className={caption}>
            Full mask: <span className="font-mono">{maskHex}</span> | Extracting: {extractedBits}
          </p>
          <p className={`${captionMuted} italic`}>
            Click and drag to select bits
          </p>
        </div>
      </div>
    </div>
  );
}
