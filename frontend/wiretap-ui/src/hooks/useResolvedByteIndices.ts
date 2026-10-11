// ui/src/hooks/useResolvedByteIndices.ts

import { useCallback, useEffect, useState } from "react";
import { resolveByteIndices } from "../api/checksums";
import { tlog } from "../api/settings";

export type ByteIndexResolver = (index: number, frameLength: number) => number | null;

const distinct = (values: number[]) => [...new Set(values.filter(Number.isInteger))].sort((a, b) => a - b);

/** Resolves each index against each frame length as the checksum engine does; null until Rust has answered for that pair. */
export function useResolvedByteIndices(indices: number[], frameLengths: number[]): ByteIndexResolver {
  const want = { indices: distinct(indices), lengths: distinct(frameLengths) };
  const key = JSON.stringify(want);
  const [resolved, setResolved] = useState<Map<string, number>>(() => new Map());
  useEffect(() => {
    let current = true;
    resolveByteIndices(want.indices, want.lengths)
      .then((rows) => {
        if (!current) return;
        setResolved(new Map(rows.flatMap((row, l) => row.map((byte, i) => [`${want.indices[i]}@${want.lengths[l]}`, byte] as const))));
      })
      .catch((e) => tlog.info(`[byteIndices] ${e}`));
    return () => {
      current = false;
    };
    // `key` names every input the request reads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return useCallback((index, frameLength) => resolved.get(`${index}@${frameLength}`) ?? null, [resolved]);
}
