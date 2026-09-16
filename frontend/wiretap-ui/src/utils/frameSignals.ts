// ui/src/utils/frameSignals.ts

import type { FrameDetail, MuxDef, SignalDef } from "../types/decoder";

/** Recursively collect all signals from a mux structure (all cases). */
export function collectMuxSignals(mux: MuxDef): SignalDef[] {
  const signals: SignalDef[] = [];
  for (const caseData of Object.values(mux.cases)) {
    signals.push(...caseData.signals);
    if (caseData.mux) {
      signals.push(...collectMuxSignals(caseData.mux));
    }
  }
  return signals;
}

/** Get all signals for a frame (plain + all mux signals). */
export function getAllFrameSignals(frame: FrameDetail): SignalDef[] {
  const signals = [...frame.signals];
  if (frame.mux) {
    signals.push(...collectMuxSignals(frame.mux));
  }
  return signals;
}
