// Copyright 2026 Wired Square Pty Ltd
// SPDX-License-Identifier: Apache-2.0

import { textPrimary, textSecondary, textTertiary } from "../../../styles";
import { type PlacedSignal, BYTE_ORDER_LE } from "../utils/bitGrid";

interface SignalListProps {
  signals: PlacedSignal[];
  selectedIndex: number | null;
  onSelect: (index: number) => void;
}

export default function SignalList({ signals, selectedIndex, onSelect }: SignalListProps) {
  if (signals.length === 0) {
    return (
      <div className={`flex items-center justify-center h-full text-center px-4 text-sm ${textTertiary}`}>
        No signals defined. Click bits in the grid to add signals.
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-0.5">
      {signals.map((signal, index) => {
        const isSelected = selectedIndex === index;
        return (
          <button
            key={signal.signalId}
            onClick={() => onSelect(index)}
            className={`w-full flex items-center gap-2 px-2 py-1.5 rounded text-left transition-colors ${
              isSelected
                ? "bg-[var(--hover-bg)] brightness-110"
                : "hover:bg-[var(--hover-bg)]"
            }`}
          >
            {/* Colour dot */}
            <span
              className="shrink-0 rounded-full"
              style={{ width: 12, height: 12, backgroundColor: signal.colour }}
            />

            {/* Signal name */}
            <span className={`flex-1 text-sm truncate ${signal.name ? textPrimary : textTertiary}`}>
              {signal.name || "(unnamed)"}
            </span>

            {/* Bit range */}
            <span className={`text-xs font-mono shrink-0 ${textSecondary}`}>
              bit{signal.startBit}:{signal.bitLength}
            </span>

            {/* Byte order badge */}
            <span className={`text-[10px] font-mono shrink-0 px-1 rounded border border-[color:var(--border-default)] ${textTertiary}`}>
              {signal.byteOrder === BYTE_ORDER_LE ? "LE" : "BE"}
            </span>
          </button>
        );
      })}
    </div>
  );
}
