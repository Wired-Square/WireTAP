// Copyright 2026 Wired Square Pty Ltd

import { VALUE_TYPE_NAMES } from "../../../generated/framelinkNames";
import { useSettingsStore } from "../../settings/stores/settingsStore";

export const BYTE_ORDER_LE = 0;
export const BYTE_ORDER_BE = 1;

export const VALUE_TYPE_UNSIGNED = 0;
export const VALUE_TYPE_SIGNED = 1;
export const VALUE_TYPE_FLOAT = 2;
export const VALUE_TYPE_BOOL = 3;
export const VALUE_TYPE_ARRAY = 4;

export const VALUE_TYPES = VALUE_TYPE_NAMES.map((name, value) => ({
  value,
  label: name.charAt(0).toUpperCase() + name.slice(1),
}));

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
      name: s.name,
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
