// ui/src/utils/catalogFrames.ts

import { NAME_KEYED_FRAME_ID } from "../generated/wireConstants";
import type { Catalog, Frame, Mux, Protocol, Signal } from "../types/catalogModel";

export function frameByKey(catalog: Catalog | null, protocol: Protocol, key: string): Frame | undefined {
  return catalog?.frames.find((f) => f.protocol === protocol && f.key === key);
}

/**
 * The catalogue's frames by bare id, as decoded frames arrive. Frames sharing an id
 * (a Modbus register read as input and as holding) are one entry carrying every
 * frame's signals.
 */
export function framesById(catalog: Catalog): Map<number, Frame> {
  const byId = new Map<number, Frame>();
  for (const frame of catalog.frames) {
    if (frame.frameId === NAME_KEYED_FRAME_ID) continue;
    const seen = byId.get(frame.frameId);
    byId.set(frame.frameId, seen
      ? { ...seen, signals: [...seen.signals, ...frame.signals], mux: seen.mux ?? frame.mux }
      : frame);
  }
  return byId;
}

function muxSignals(mux: Mux): Signal[] {
  return Object.values(mux.cases).flatMap((c) => [...c.signals, ...(c.mux ? muxSignals(c.mux) : [])]);
}

/** A frame's plain signals, then every mux case's. */
export function allFrameSignals(frame: Frame): Signal[] {
  return frame.mux ? [...frame.signals, ...muxSignals(frame.mux)] : frame.signals;
}
