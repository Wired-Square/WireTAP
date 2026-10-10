// Copyright 2026 Wired Square Pty Ltd

import { useEffect, useState } from "react";
import { framelinkBitOwners, framelinkNextId, type FrameLinkIdKind } from "../../../api/framelinkRules";
import { tlog } from "../../../api/settings";
import type { PlacedSignal } from "../utils/bitGrid";

const NO_OWNERS: (number | null)[] = [];

/** The latest answer for `key`, keeping the previous one until it arrives. */
function useAnswer<T>(key: string, ask: () => Promise<T>): T | null {
  const [answer, setAnswer] = useState<T | null>(null);
  useEffect(() => {
    let cancelled = false;
    ask()
      .then((value) => {
        if (!cancelled) setAnswer(value);
      })
      .catch((e) => tlog.info(`[rules] ${key}: ${e}`));
    return () => {
      cancelled = true;
    };
    // `key` names every input `ask` reads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return answer;
}

/** Which signal (by index) owns each payload bit. */
export function useBitOwners(signals: PlacedSignal[], payloadBytes: number): (number | null)[] {
  const placements = signals.map((s) => ({ start_bit: s.startBit, bit_length: s.bitLength, byte_order: s.byteOrder }));
  const key = JSON.stringify([placements, payloadBytes]);
  return useAnswer(key, () => framelinkBitOwners(placements, payloadBytes)) ?? NO_OWNERS;
}

export function useNextFrameLinkId(used: Set<number>, kind: FrameLinkIdKind): number | null {
  const ids = [...used].sort((a, b) => a - b);
  return useAnswer(`${kind}:${ids.join(",")}`, () => framelinkNextId(ids, kind));
}

/** An id field that takes the next free id each time its dialog opens. */
export function useNextIdField(used: Set<number>, kind: FrameLinkIdKind, isOpen: boolean) {
  const next = useNextFrameLinkId(used, kind);
  const [id, setId] = useState(0);
  useEffect(() => {
    if (isOpen && next !== null) setId(next);
  }, [isOpen, next]);
  return [id, setId] as const;
}
