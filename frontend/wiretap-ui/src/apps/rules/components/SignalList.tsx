// Copyright 2026 Wired Square Pty Ltd

import { textPrimary, textSecondary } from "../../../styles";
import { Badge } from "../../../components/Badge";
import { Listbox, Option } from "../../../components/Listbox";
import { type PlacedSignal, BYTE_ORDER_LE } from "../utils/bitGrid";

interface SignalListProps {
  signals: PlacedSignal[];
  selectedIndex: number | null;
  onSelect: (index: number) => void;
}

export default function SignalList({ signals, selectedIndex, onSelect }: SignalListProps) {
  if (signals.length === 0) {
    return (
      <div className={`flex items-center justify-center h-full text-center px-4 text-sm ${textSecondary}`}>
        No signals defined. Click bits in the grid to add signals.
      </div>
    );
  }

  return (
    <Listbox className="p-0 gap-0.5">
      {signals.map((signal, index) => {
        const isSelected = selectedIndex === index;
        return (
          <Option
            key={signal.signalId}
            selected={isSelected}
            size="sm"
            className="gap-2 px-2"
            onClick={() => onSelect(index)}
          >
            {/* Colour dot */}
            <span
              className="shrink-0 rounded-full"
              style={{ width: 12, height: 12, backgroundColor: signal.colour }}
            />

            {/* Signal name */}
            <span className={`flex-1 text-sm truncate ${signal.name ? textPrimary : textSecondary}`}>
              {signal.name || "(unnamed)"}
            </span>

            {/* Bit range */}
            <span className={`text-xs font-mono shrink-0 ${textSecondary}`}>
              bit{signal.startBit}:{signal.bitLength}
            </span>

            {/* Byte order badge */}
            <Badge variant="outline" size="sm" mono>
              {signal.byteOrder === BYTE_ORDER_LE ? "LE" : "BE"}
            </Badge>
          </Option>
        );
      })}
    </Listbox>
  );
}
