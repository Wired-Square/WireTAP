// ui/src/apps/calculator/frameUtils.ts

import {
  twosComplementSigned,
  onesComplementSigned,
  signMagnitudeSigned,
  toBinaryString,
  cleanHex,
  numberToHex,
  hexToBytes,
} from '../../utils/numberUtils';
import { bytesToAscii } from '../../utils/byteUtils';
import type { Endianness, GroupMode, GroupedValue } from './FrameCalculator';

// Re-export for backwards compatibility
export { cleanHex, numberToHex, hexToBytes };

export function reorderBytes(bytes: number[], endianness: Endianness): number[] {
  if (endianness === "little") {
    return [...bytes].reverse();
  }

  if (endianness === "mid-little") {
    const chunks: number[][] = [];
    for (let i = 0; i < bytes.length; i += 2) {
      const chunk = bytes.slice(i, i + 2);
      chunks.push(chunk.reverse());
    }
    return chunks.flat().reverse();
  }

  if (endianness === "mid-big") {
    const chunks: number[][] = [];
    for (let i = 0; i < bytes.length; i += 2) {
      const chunk = bytes.slice(i, i + 2);
      chunks.push(chunk.reverse());
    }
    return chunks.flat();
  }

  return [...bytes];
}

export function bitsToNumber(bits: number[], endianness: Endianness, backingBytes: number[] | null): bigint {
  const len = bits.length;
  if (len === 0) return 0n;

  // Use BigInt to avoid precision loss
  if (len % 8 === 0 && backingBytes) {
    const orderedBytes = reorderBytes(backingBytes, endianness);
    let value = 0n;
    for (const b of orderedBytes) {
      value = (value << 8n) | BigInt(b & 0xff);
    }
    return value;
  }

  let value = 0n;
  for (const b of bits) {
    value = (value << 1n) | BigInt(b & 1);
  }
  return value;
}

export function parseSizes(input: string, multiplyBy: number): number[] {
  const parts = input
    .split(",")
    .map((p) => p.trim().replace(/_/g, ""))
    .filter((p) => p.length > 0);
  const nums = parts
    .map((p) => {
      const n = parseInt(p, 10);
      return isNaN(n) || n <= 0 ? null : n * multiplyBy;
    })
    .filter((n): n is number => n !== null);
  return nums.length > 0 ? nums : [8];
}

export function decodeGroups(
  bytes: number[],
  mode: GroupMode,
  customInput: string,
  endianness: Endianness
): GroupedValue[] {
  if (bytes.length === 0) return [];

  // For 1B mode, reorder the entire byte array first
  const sourceBytes = mode === "1B" ? reorderBytes(bytes, endianness) : bytes;

  const groups: GroupedValue[] = [];

  const groupSizes = (() => {
    switch (mode) {
      case "1B":
        return [8];
      case "2B":
        return [16];
      case "4B":
        return [32];
      case "8B":
        return [64];
      case "custom-bits": {
        const parsed = parseSizes(customInput, 1);
        return parsed.length > 0 ? parsed : [8];
      }
      case "custom-bytes": {
        const parsed = parseSizes(customInput, 8);
        return parsed.length > 0 ? parsed : [8];
      }
      default:
        return [8];
    }
  })();

  const sizeCount = groupSizes.length;

  const isStandardByteMode = mode === "1B" || mode === "2B" || mode === "4B" || mode === "8B";

  if (isStandardByteMode) {
    // Standard byte mode: extract complete bytes
    const bytesPerGroup = groupSizes[0] / 8;
    let byteIdx = 0;

    while (byteIdx < sourceBytes.length) {
      const groupBytes = sourceBytes.slice(byteIdx, byteIdx + bytesPerGroup);
      if (groupBytes.length === 0) break;

      // For standard byte modes, apply byte ordering to get the value
      const orderedBytes = reorderBytes(groupBytes, endianness);

      // Convert bytes to bits for display
      const extractedBits: number[] = [];
      for (const byte of orderedBytes) {
        for (let b = 7; b >= 0; b--) {
          extractedBits.push((byte >> b) & 1);
        }
      }

      const value = bitsToNumber(extractedBits, "big", null);
      const twos = twosComplementSigned(value, extractedBits.length);
      const ones = onesComplementSigned(value, extractedBits.length);
      const mag = signMagnitudeSigned(value, extractedBits.length);

      const paddedHex = Math.ceil(extractedBits.length / 4);
      const hex = value.toString(16).padStart(paddedHex, "0");

      const text = bytesToAscii(groupBytes);
      const binary = toBinaryString(extractedBits, 8);

      // Calculate startByteIndex based on original byte positions
      // In 1B mode, sourceBytes are already reordered, so we need to map back to original positions
      let originalByteIndex = byteIdx;
      if (mode === "1B") {
        // For 1B mode with reordering, map from reordered position back to original
        // Little endian reverses the array, so original position is (length - 1 - byteIdx)
        if (endianness === "little") {
          originalByteIndex = bytes.length - 1 - byteIdx;
        }
        // For big/mid-big/mid-little in 1B mode, no reordering happens (reorderBytes returns copy)
        // so byteIdx is already correct
      }

      // For ByteBits visualization: extract bytes from ORIGINAL data at the correct position
      // This ensures ByteBits shows and toggles the actual bytes at their original positions
      const displayBytes = bytes.slice(originalByteIndex, originalByteIndex + bytesPerGroup);
      const displayHex = displayBytes.map(b => b.toString(16).padStart(2, "0")).join("");

      // For standard byte modes, the used bits are simply the full range of bytes
      const usedBitStart = originalByteIndex * 8;
      const usedBitEnd = originalByteIndex * 8 + extractedBits.length - 1;

      groups.push({
        index: groups.length + 1,
        bits: extractedBits.length,
        hex: "0x" + hex,
        unsigned: value,
        signedTwos: twos,
        signedOnes: ones,
        signedMag: mag,
        text,
        binary,
        displayHex: "0x" + displayHex,
        bitOffset: originalByteIndex * 8 + extractedBits.length - 1, // Global MSB position
        startByteIndex: originalByteIndex,
        usedBitStart,
        usedBitEnd,
      });

      byteIdx += bytesPerGroup;
    }
  } else {
    // Custom-bits mode: extract individual bits
    // For big endian: starts at 7, counts down (wrapping to next byte's bit 7 when needed)
    // For little endian: starts at 0, counts up
    let currentBitPosition = (endianness === "big" || endianness === "mid-big") ? 7 : 0;
    let idx = 0;

    while (currentBitPosition >= 0 && currentBitPosition < sourceBytes.length * 8) {
      const size = groupSizes[idx % sizeCount];
      if (size <= 0) break;

      const startBit = currentBitPosition;

      // Calculate which bytes this signal spans
      const startByte = Math.floor(startBit / 8);
      // For CAN big-endian bit ordering, signals start at MSB and flow down then to next byte
      // So bytesNeeded is simply ceil(size/8) since each byte contributes 8 bits sequentially
      // For little endian, bits span differently and may cross byte boundaries mid-byte
      const bytesNeeded = (endianness === "big" || endianness === "mid-big")
        ? Math.ceil(size / 8)
        : Math.ceil((startBit % 8 + 1 + size - 1) / 8);

      if (startByte >= sourceBytes.length) break;

      const groupBytes = sourceBytes.slice(startByte, Math.min(startByte + bytesNeeded, sourceBytes.length));
      if (groupBytes.length === 0) break;

      // Extract bits in the correct order based on endianness
      let extractedBits: number[] = [];
      let lastBitPosition = startBit;
      let highestBitPosition = startBit;
      let lowestBitPosition = startBit;

      if (endianness === "big" || endianness === "mid-big") {
        // Big endian: extract from MSB downward, wrapping to next byte
        let currentBit = startBit;
        for (let i = 0; i < size; i++) {
          const byteIdx = Math.floor(currentBit / 8);
          const bitInByte = currentBit % 8;
          if (byteIdx >= sourceBytes.length) break;

          const bit = (sourceBytes[byteIdx] >> bitInByte) & 1;
          extractedBits.push(bit);
          lastBitPosition = currentBit;

          // Track the range of bit positions
          if (currentBit > highestBitPosition) highestBitPosition = currentBit;
          if (currentBit < lowestBitPosition) lowestBitPosition = currentBit;

          // Move to next bit: go down within byte, or wrap to next byte's MSB
          if (bitInByte === 0) {
            currentBit = (byteIdx + 1) * 8 + 7;
          } else {
            currentBit--;
          }
        }
      } else {
        // Little endian: extract from LSB upward
        for (let i = 0; i < size; i++) {
          const bitPos = startBit + i;
          const byteIdx = Math.floor(bitPos / 8);
          const bitInByte = bitPos % 8;
          if (byteIdx >= sourceBytes.length) break;

          const bit = (sourceBytes[byteIdx] >> bitInByte) & 1;
          extractedBits.push(bit);
          lastBitPosition = bitPos;

          // Track the range of bit positions
          if (bitPos > highestBitPosition) highestBitPosition = bitPos;
          if (bitPos < lowestBitPosition) lowestBitPosition = bitPos;
        }
      }

      if (extractedBits.length === 0) break;

      // For little endian, bits were extracted LSB-first but bitsToNumber expects MSB-first
      // So we need to reverse the array for little endian
      const bitsForValue = (endianness === "little" || endianness === "mid-little")
        ? [...extractedBits].reverse()
        : extractedBits;
      const value = bitsToNumber(bitsForValue, "big", null);
      const twos = twosComplementSigned(value, extractedBits.length);
      const ones = onesComplementSigned(value, extractedBits.length);
      const mag = signMagnitudeSigned(value, extractedBits.length);

      const paddedHex = Math.ceil(extractedBits.length / 4);
      const hex = value.toString(16).padStart(paddedHex, "0");

      const text = bytesToAscii(groupBytes);
      // Use bitsForValue for binary display so it matches the computed value
      const binary = toBinaryString(bitsForValue, 8);

      // For ByteBits visualization: display full bytes with proper bit offset
      const displayHex = groupBytes.map(b => b.toString(16).padStart(2, "0")).join("");

      // For ByteBits: bitOffset is the global bit position (highest for big endian, lowest for little)
      const globalBitOffset = (endianness === "big" || endianness === "mid-big")
        ? highestBitPosition
        : lowestBitPosition;

      groups.push({
        index: idx + 1,
        bits: extractedBits.length,
        hex: "0x" + hex,
        unsigned: value,
        signedTwos: twos,
        signedOnes: ones,
        signedMag: mag,
        text,
        binary,
        displayHex: "0x" + displayHex,
        bitOffset: globalBitOffset,
        startByteIndex: startByte, // Starting byte position in the original data
        usedBitStart: lowestBitPosition,
        usedBitEnd: highestBitPosition,
      });

      // Custom-bits mode: advance bit-by-bit
      if (endianness === "big" || endianness === "mid-big") {
        const byteIdx = Math.floor(lastBitPosition / 8);
        const bitInByte = lastBitPosition % 8;
        if (bitInByte === 0) {
          currentBitPosition = (byteIdx + 1) * 8 + 7;
        } else {
          currentBitPosition = lastBitPosition - 1;
        }
      } else {
        currentBitPosition = lastBitPosition + 1;
      }

      idx++;
    }
  }

  return groups;
}
