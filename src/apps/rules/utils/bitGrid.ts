// Copyright 2026 Wired Square Pty Ltd
// SPDX-License-Identifier: Apache-2.0

export const BYTE_ORDER_LE = 0;
export const BYTE_ORDER_BE = 1;

export const VALUE_TYPE_UNSIGNED = 0;
export const VALUE_TYPE_SIGNED = 1;
export const VALUE_TYPE_FLOAT = 2;
export const VALUE_TYPE_BOOL = 3;
export const VALUE_TYPE_ARRAY = 4;

export const VALUE_TYPES = [
  { value: VALUE_TYPE_UNSIGNED, label: "Unsigned" },
  { value: VALUE_TYPE_SIGNED, label: "Signed" },
  { value: VALUE_TYPE_FLOAT, label: "Float" },
  { value: VALUE_TYPE_BOOL, label: "Bool" },
  { value: VALUE_TYPE_ARRAY, label: "Array" },
];

import { useSettingsStore } from "../../settings/stores/settingsStore";

export function getSignalColours(): string[] {
  return useSettingsStore.getState().display.frameEditorColours;
}

export interface PlacedSignal {
  signalId: number;
  name: string;
  startBit: number;
  bitLength: number;
  byteOrder: number;
  valueType: number;
  scale: number;
  offset: number;
  colour: string;
}

export type FrameHeader =
  | { type: "can"; canId: number; dlc: number; extended: boolean }
  | { type: "serial"; framingMode: number };

// Ported from framelink-rs/src/protocol/frame_def.rs — Motorola bit snaking:
// within a byte bits descend 7→0, then jump to bit 7 of the next byte.
export function motorolaBitPositions(startBit: number, bitLength: number): number[] {
  const positions: number[] = [];
  let bit = startBit;
  for (let i = 0; i < bitLength; i++) {
    positions.push(bit);
    const bitInByte = bit % 8;
    if (bitInByte === 0) {
      bit += 15;
    } else {
      bit -= 1;
    }
  }
  return positions;
}

export function signalBitPositions(startBit: number, bitLength: number, byteOrder: number): number[] {
  if (byteOrder === BYTE_ORDER_BE) {
    return motorolaBitPositions(startBit, bitLength);
  }
  return Array.from({ length: bitLength }, (_, i) => startBit + i);
}

export function buildBitOwnerMap(
  signals: PlacedSignal[],
  payloadBytes: number,
): (number | null)[] {
  const totalBits = payloadBytes * 8;
  const map: (number | null)[] = new Array(totalBits).fill(null);
  for (let i = 0; i < signals.length; i++) {
    const positions = signalBitPositions(
      signals[i].startBit,
      signals[i].bitLength,
      signals[i].byteOrder,
    );
    for (const pos of positions) {
      if (pos < totalBits) {
        map[pos] = i;
      }
    }
  }
  return map;
}

export function checkOverlap(
  startBit: number,
  bitLength: number,
  byteOrder: number,
  existingSignals: PlacedSignal[],
  payloadBytes: number,
): boolean {
  const ownerMap = buildBitOwnerMap(existingSignals, payloadBytes);
  const positions = signalBitPositions(startBit, bitLength, byteOrder);
  return positions.some((pos) => pos < ownerMap.length && ownerMap[pos] !== null);
}

// Signal ID 0 is not used; IDs start at 1 (matching the TUI convention)
export function nextSignalId(signals: PlacedSignal[]): number {
  let id = 1;
  while (signals.some((s) => s.signalId === id)) {
    id++;
  }
  return id;
}

export function nextSignalColour(signals: PlacedSignal[]): string {
  const colours = getSignalColours();
  const used = new Set(signals.map((s) => s.colour));
  const unused = colours.find((c) => !used.has(c));
  return unused ?? colours[signals.length % colours.length];
}

export function normaliseRange(a: number, b: number): { startBit: number; bitLength: number } {
  const min = Math.min(a, b);
  const max = Math.max(a, b);
  return { startBit: min, bitLength: max - min + 1 };
}

export type ValidationError = string | null;

export function validateSignalType(bitLength: number, valueType: number): ValidationError {
  switch (valueType) {
    case VALUE_TYPE_BOOL:
      return bitLength !== 1 ? "Bool requires exactly 1 bit" : null;
    case VALUE_TYPE_FLOAT:
      return bitLength !== 32 ? "Float requires exactly 32 bits" : null;
    case VALUE_TYPE_ARRAY:
      return bitLength % 8 !== 0 ? "Array requires a multiple of 8 bits" : null;
    default:
      return bitLength > 64 ? "Maximum 64 bits for integer signals" : null;
  }
}

export function canSave(signals: PlacedSignal[]): boolean {
  if (signals.length === 0) return true;
  return signals.every((s) => s.name.trim().length > 0);
}

export interface FrameDefPayload {
  frame_def_id: number;
  interface_type: number;
  can_id?: number;
  dlc?: number;
  extended?: boolean;
  framing_mode?: number;
  signals: {
    signal_id: number;
    start_bit: number;
    bit_length: number;
    byte_order: number;
    value_type: number;
    scale: number;
    offset: number;
  }[];
}

export function serialiseFrameDef(
  frameDefId: number,
  interfaceType: number,
  header: FrameHeader,
  signals: PlacedSignal[],
): FrameDefPayload {
  const payload: FrameDefPayload = {
    frame_def_id: frameDefId,
    interface_type: interfaceType,
    signals: signals.map((s) => ({
      signal_id: s.signalId,
      start_bit: s.startBit,
      bit_length: s.bitLength,
      byte_order: s.byteOrder,
      value_type: s.valueType,
      scale: s.scale,
      offset: s.offset,
    })),
  };
  if (header.type === "can") {
    payload.can_id = header.canId;
    payload.dlc = header.dlc;
    payload.extended = header.extended;
  } else {
    payload.framing_mode = header.framingMode;
  }
  return payload;
}
