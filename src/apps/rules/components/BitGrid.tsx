// Copyright 2026 Wired Square Pty Ltd
// SPDX-License-Identifier: Apache-2.0
//
// Visual bit grid for frame definition editing. Renders bytes as rows of 8
// bit cells (MSB-first: 7,6,5,4,3,2,1,0 left-to-right). Users click bits
// to anchor selection and complete ranges for placing signals.

import { useState, useMemo, useRef, useEffect, useCallback, forwardRef } from "react";
import { textPrimary, textSecondary, textTertiary, focusRingThin } from "../../../styles";
import { type PlacedSignal, buildBitOwnerMap } from "../utils/bitGrid";

// Column indices 0..7 display bits 7..0 (MSB first)
const COLUMN_HEADERS = [7, 6, 5, 4, 3, 2, 1, 0] as const;

interface BitGridProps {
  payloadBytes: number;
  signals: PlacedSignal[];
  selectionAnchor: number | null;
  selectedSignalIndex: number | null;
  onBitClick: (bit: number) => void;
  onByteClick: (byteOffset: number) => void;
  scrollToByte: number | null;
}

export default function BitGrid({
  payloadBytes,
  signals,
  selectionAnchor,
  selectedSignalIndex,
  onBitClick,
  onByteClick,
  scrollToByte,
}: BitGridProps) {
  const [hoveredBit, setHoveredBit] = useState<number | null>(null);
  const [jumpInput, setJumpInput] = useState("");

  const scrollRef = useRef<HTMLDivElement>(null);
  const rowRefs = useRef<Map<number, HTMLDivElement>>(new Map());

  const ownerMap = useMemo(
    () => buildBitOwnerMap(signals, payloadBytes),
    [signals, payloadBytes],
  );

  // Pending selection range when anchor is set and hovering
  const pendingRange = useMemo(() => {
    if (selectionAnchor === null || hoveredBit === null) return null;
    const min = Math.min(selectionAnchor, hoveredBit);
    const max = Math.max(selectionAnchor, hoveredBit);
    const bits = new Set<number>();
    for (let i = min; i <= max; i++) bits.add(i);
    const hasOverlap = Array.from(bits).some(
      (b) => b < ownerMap.length && ownerMap[b] !== null,
    );
    return { bits, hasOverlap };
  }, [selectionAnchor, hoveredBit, ownerMap]);

  // Scroll-to-byte navigation
  useEffect(() => {
    if (scrollToByte === null) return;
    const row = rowRefs.current.get(scrollToByte);
    if (row) {
      row.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, [scrollToByte]);

  const handleJump = useCallback(() => {
    const value = parseInt(jumpInput, 10);
    if (isNaN(value) || value < 0 || value >= payloadBytes) return;
    const row = rowRefs.current.get(value);
    if (row) {
      row.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, [jumpInput, payloadBytes]);

  const handleJumpKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter") handleJump();
    },
    [handleJump],
  );

  return (
    <div className="flex flex-col">
      {/* Header row */}
      <div className="flex items-center gap-1 px-1 pb-1">
        <div className={`w-10 text-right text-[10px] font-mono pr-1 ${textTertiary}`}>
          Byte
        </div>
        {COLUMN_HEADERS.map((bit) => (
          <div
            key={bit}
            className={`w-6 h-5 flex items-center justify-center text-[10px] font-mono ${textSecondary}`}
          >
            {bit}
          </div>
        ))}
        {/* Jump-to-byte input */}
        <div className="ml-2 flex items-center gap-1">
          <input
            type="number"
            min={0}
            max={payloadBytes - 1}
            value={jumpInput}
            onChange={(e) => setJumpInput(e.target.value)}
            onKeyDown={handleJumpKeyDown}
            placeholder="Go to"
            className={`w-16 h-5 text-[10px] font-mono px-1 rounded border bg-[var(--bg-primary)] border-[color:var(--border-default)] text-[color:var(--text-primary)] ${focusRingThin}`}
          />
          <button
            onClick={handleJump}
            className={`h-5 px-1.5 text-[10px] rounded border border-[color:var(--border-default)] bg-[var(--bg-surface)] ${textSecondary} hover:brightness-90`}
          >
            Go
          </button>
        </div>
      </div>

      {/* Scrollable grid */}
      <div
        ref={scrollRef}
        className="overflow-y-auto max-h-[400px] border rounded border-[color:var(--border-default)]"
      >
        {Array.from({ length: payloadBytes }, (_, byteOffset) => (
          <ByteRow
            key={byteOffset}
            byteOffset={byteOffset}
            ownerMap={ownerMap}
            signals={signals}
            selectionAnchor={selectionAnchor}
            selectedSignalIndex={selectedSignalIndex}
            pendingRange={pendingRange}
            onBitClick={onBitClick}
            onByteClick={onByteClick}
            onBitHover={setHoveredBit}
            ref={(el) => {
              if (el) {
                rowRefs.current.set(byteOffset, el);
              } else {
                rowRefs.current.delete(byteOffset);
              }
            }}
          />
        ))}
      </div>
    </div>
  );
}

// --- ByteRow ---

interface ByteRowProps {
  byteOffset: number;
  ownerMap: (number | null)[];
  signals: PlacedSignal[];
  selectionAnchor: number | null;
  selectedSignalIndex: number | null;
  pendingRange: { bits: Set<number>; hasOverlap: boolean } | null;
  onBitClick: (bit: number) => void;
  onByteClick: (byteOffset: number) => void;
  onBitHover: (bit: number | null) => void;
}

const ByteRow = forwardRef<HTMLDivElement, ByteRowProps>(function ByteRow(
  {
    byteOffset,
    ownerMap,
    signals,
    selectionAnchor,
    selectedSignalIndex,
    pendingRange,
    onBitClick,
    onByteClick,
    onBitHover,
  },
  ref,
) {
  return (
    <div ref={ref} className="flex items-center gap-1 px-1" style={{ height: 24 }}>
      <button
        onClick={() => onByteClick(byteOffset)}
        className={`w-10 text-right text-[10px] font-mono pr-1 shrink-0 cursor-pointer hover:underline ${textSecondary}`}
      >
        {byteOffset}
      </button>
      {COLUMN_HEADERS.map((_, colIdx) => {
        const bitIndex = byteOffset * 8 + (7 - colIdx);
        const owner = bitIndex < ownerMap.length ? ownerMap[bitIndex] : null;
        const isSelected = owner !== null && owner === selectedSignalIndex;
        const signalColour = owner !== null ? signals[owner]?.colour ?? null : null;
        const isPending = pendingRange?.bits.has(bitIndex) ?? false;
        const isBitAnchor = selectionAnchor === bitIndex;

        let cellStyle: React.CSSProperties | undefined;
        let bgClass: string | undefined;

        if (isPending) {
          bgClass = pendingRange!.hasOverlap
            ? "bg-red-500/40"
            : "bg-yellow-400/40";
        } else if (isSelected && signalColour) {
          cellStyle = { backgroundColor: signalColour, color: "#000" };
        } else if (signalColour) {
          cellStyle = { backgroundColor: signalColour, opacity: 0.7, color: "#000" };
        } else {
          bgClass = "bg-white/5";
        }

        return (
          <BitCell
            key={colIdx}
            bitIndex={bitIndex}
            owner={owner}
            bgClass={bgClass}
            cellStyle={cellStyle}
            isAnchor={isBitAnchor}
            onBitClick={onBitClick}
            onBitHover={onBitHover}
          />
        );
      })}
    </div>
  );
});

// --- BitCell ---

interface BitCellProps {
  bitIndex: number;
  owner: number | null;
  bgClass?: string;
  cellStyle?: React.CSSProperties;
  isAnchor: boolean;
  onBitClick: (bit: number) => void;
  onBitHover: (bit: number | null) => void;
}

function BitCell({
  bitIndex,
  owner,
  bgClass,
  cellStyle,
  isAnchor,
  onBitClick,
  onBitHover,
}: BitCellProps) {
  return (
    <button
      className={`w-6 h-5 text-[10px] font-mono flex items-center justify-center rounded-sm cursor-pointer ${bgClass ?? ""} ${isAnchor ? "ring-2 ring-yellow-400" : ""}`}
      style={cellStyle}
      onClick={() => onBitClick(bitIndex)}
      onMouseEnter={() => onBitHover(bitIndex)}
      onMouseLeave={() => onBitHover(null)}
    >
      <span className={owner !== null ? textPrimary : textTertiary}>
        {bitIndex}
      </span>
    </button>
  );
}
