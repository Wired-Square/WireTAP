// ui/src/apps/catalog/views/signalRanges.ts

import type { BitRange } from "../../../components/BitPreview";
import type { Mux, Signal } from "../../../types/catalogModel";

/** A signal or selector as `previewRanges` names it, for BitPreview's colour lookup. */
export function signalRange(signal: Signal): BitRange {
  return { name: signal.name ?? "Signal", start_bit: signal.startBit ?? 0, bit_length: signal.bitLength ?? 0, type: "signal" };
}

export function selectorRange(mux: Mux): BitRange {
  return { name: mux.name ?? "Mux", start_bit: mux.startBit, bit_length: mux.bitLength, type: "mux" };
}

export function muxSignalCount(mux: Mux): number {
  return Object.values(mux.cases).reduce((n, c) => n + c.signals.length + (c.mux ? muxSignalCount(c.mux) : 0), 0);
}
