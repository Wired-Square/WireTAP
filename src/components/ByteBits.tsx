import { useMemo } from 'react';
import { useSettings } from '../hooks/useSettings';
import { flexRowGap2 } from '../styles/spacing';

interface ByteBitsProps {
  hexValue: string;
  byteOrder?: 'little' | 'big' | 'mid-little' | 'mid-big';
  /** Colour for binary 1 bits - defaults to settings binary_one_colour */
  bitColor?: string;
  /** Colour for binary 0 bits - defaults to settings binary_zero_colour */
  zeroColor?: string;
  /** Colour for unused bits - defaults to settings binary_unused_colour */
  unusedColor?: string;
  totalBits?: number;
  /** Starting bit position within the displayed bytes (e.g., bit 7 for MSB of first byte) */
  bitOffset?: number;
  onBitToggle?: (newHexValue: string) => void;
  interactive?: boolean;
  startByteIndex?: number;
  /** Explicit bit range that is used (inclusive). If provided, takes precedence over bitOffset/totalBits calculation */
  usedBitStart?: number;
  usedBitEnd?: number;
}

export default function ByteBits({
  hexValue,
  byteOrder = 'big',
  bitColor: bitColorProp,
  zeroColor: zeroColorProp,
  unusedColor: unusedColorProp,
  totalBits,
  bitOffset = 0,
  onBitToggle,
  interactive = false,
  startByteIndex = 0,
  usedBitStart,
  usedBitEnd,
}: ByteBitsProps) {
  const { settings } = useSettings();
  // Use props if provided, otherwise fall back to settings, then defaults
  const bitColor = bitColorProp ?? settings?.binary_one_colour ?? '#14b8a6';
  const zeroColor = zeroColorProp ?? settings?.binary_zero_colour ?? '#94a3b8';
  const unusedColor = unusedColorProp ?? settings?.binary_unused_colour ?? '#64748b';
  const bytes = useMemo(() => {
    // Strip 0x prefix and any non-hex characters
    const clean = hexValue.replace(/^0x/i, '').replace(/[^0-9a-fA-F]/g, '');
    const byteArray: number[] = [];

    for (let i = 0; i < clean.length; i += 2) {
      const byte = parseInt(clean.slice(i, i + 2), 16);
      if (!isNaN(byte)) {
        byteArray.push(byte);
      }
    }

    // Apply byte ordering
    if (byteOrder === 'little') {
      return byteArray.reverse();
    } else if (byteOrder === 'mid-little' && byteArray.length > 1) {
      const result = [];
      for (let i = 0; i < byteArray.length; i += 2) {
        if (i + 1 < byteArray.length) {
          result.push(byteArray[i + 1], byteArray[i]);
        } else {
          result.push(byteArray[i]);
        }
      }
      return result;
    } else if (byteOrder === 'mid-big' && byteArray.length > 1) {
      const result = [];
      for (let i = byteArray.length - 1; i >= 0; i -= 2) {
        if (i > 0) {
          result.push(byteArray[i - 1], byteArray[i]);
        } else {
          result.push(byteArray[i]);
        }
      }
      return result;
    }

    return byteArray;
  }, [hexValue, byteOrder]);

  const handleBitToggle = (byteIdx: number, bitInByte: number) => {
    if (!interactive || !onBitToggle) return;

    // Create a mutable copy of the bytes array
    const newBytes = [...bytes];
    const bitPosition = 7 - bitInByte; // Convert display position to bit position

    // Toggle the bit
    newBytes[byteIdx] ^= (1 << bitPosition);

    // Convert back to hex string with 0x prefix
    const newHex = '0x' + newBytes.map(b => b.toString(16).padStart(2, '0')).join('');
    onBitToggle(newHex);
  };

  return (
    <div className="space-y-1 select-none">
      {bytes.map((byte, byteIdx) => {
        const displayByteIndex = startByteIndex + byteIdx;
        // Calculate the actual bit positions based on the original byte position
        const globalStartBit = displayByteIndex * 8;

        return (
          <div key={byteIdx} className={flexRowGap2}>
            <div className="text-xs font-mono text-[color:var(--text-muted)] w-8 flex items-center shrink-0">
              [{displayByteIndex}]
            </div>

            <div className="flex gap-1">
              {Array.from({ length: 8 }).map((_, bitInByte) => {
                // Bits are displayed high to low (left to right)
                // bitIdx represents the actual bit position in the ORIGINAL data
                const bitIdx = globalStartBit + (7 - bitInByte);

                // Get bit value from byte
                const bitValue = (byte >> (7 - bitInByte)) & 1;

                // Check if this bit is within the used range
                // If explicit usedBitStart/usedBitEnd are provided, use those directly
                // Otherwise fall back to bitOffset/totalBits calculation
                let isUsed = totalBits === undefined && usedBitStart === undefined;
                if (usedBitStart !== undefined && usedBitEnd !== undefined) {
                  // Simple range check - bit is used if within [usedBitStart, usedBitEnd]
                  isUsed = bitIdx >= usedBitStart && bitIdx <= usedBitEnd;
                } else if (totalBits !== undefined && bitOffset !== undefined) {
                  if (byteOrder === 'big' || byteOrder === 'mid-big') {
                    // Big endian: highlight from bitOffset down
                    isUsed = bitIdx <= bitOffset && bitIdx > bitOffset - totalBits;
                  } else {
                    // Little endian: highlight from bitOffset up
                    isUsed = bitIdx >= bitOffset && bitIdx < bitOffset + totalBits;
                  }
                }

                const canToggle = interactive && isUsed;

                return (
                  <div
                    key={bitInByte}
                    onClick={() => canToggle && handleBitToggle(byteIdx, bitInByte)}
                    className={`h-8 w-10 flex items-center justify-center shrink-0 ${
                      !isUsed ? 'opacity-40' : ''
                    } ${canToggle ? 'cursor-pointer hover:ring-2 hover:ring-[color:var(--accent-primary)] transition-all' : ''}`}
                    style={{ backgroundColor: isUsed ? (bitValue === 1 ? bitColor : zeroColor) : unusedColor }}
                    title={`Bit ${bitIdx}: ${bitValue}${!isUsed ? ' (unused)' : ''}${canToggle ? ' (click to toggle)' : ''}`}
                  >
                    <span className={`text-xs font-medium ${isUsed ? 'text-white' : 'text-[color:var(--text-muted)]'}`}>
                      {bitIdx}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}
