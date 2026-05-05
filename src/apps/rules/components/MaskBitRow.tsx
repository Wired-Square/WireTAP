// Copyright 2026 Wired Square Pty Ltd
// SPDX-License-Identifier: Apache-2.0

import { textPrimary, textSecondary, textTertiary } from "../../../styles";

interface MaskBitRowProps {
  label: string;
  value: number;
  mask?: number;
  bitWidth: number;
  showHeader?: boolean;
  dimWhenMaskZero?: boolean;
}

const CELL_WIDTH = "w-5";

export default function MaskBitRow({
  label,
  value,
  mask,
  bitWidth,
  showHeader = false,
  dimWhenMaskZero = false,
}: MaskBitRowProps) {
  const bits = Array.from({ length: bitWidth }, (_, i) => bitWidth - 1 - i);

  return (
    <div>
      {showHeader && (
        <div className="flex items-center gap-1 mb-1">
          <div className={`w-16 text-[10px] font-mono ${textTertiary}`}>bit</div>
          {bits.map((bitIdx) => (
            <div
              key={bitIdx}
              className={`${CELL_WIDTH} text-center text-[10px] font-mono ${textTertiary}`}
            >
              {bitIdx}
            </div>
          ))}
        </div>
      )}
      <div className="flex items-center gap-1">
        <div className={`w-16 text-[10px] font-mono ${textSecondary}`}>{label}</div>
        {bits.map((bitIdx) => {
          const bitVal = (value >>> bitIdx) & 1;
          const maskBit = mask !== undefined ? (mask >>> bitIdx) & 1 : 1;
          const isDontCare = dimWhenMaskZero && maskBit === 0;
          const display = isDontCare ? "·" : String(bitVal);
          const colour = isDontCare ? textTertiary : textPrimary;
          return (
            <div
              key={bitIdx}
              className={`${CELL_WIDTH} h-5 flex items-center justify-center text-[11px] font-mono ${colour}`}
            >
              {display}
            </div>
          );
        })}
      </div>
    </div>
  );
}
