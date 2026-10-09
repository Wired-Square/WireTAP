// ui/src/utils/mirrorBytes.ts
//
// The bytes a mirror frame reproduces are Rust's answer
// (`wiretap_catalog::mirror::inherited_byte_indices`); this only spans a signal
// for highlighting.

import type { Signal } from "../types/catalogModel";

export function signalByteIndices({ startBit = 0, bitLength = 8 }: Signal): Set<number> {
  const indices = new Set<number>();

  const startByte = Math.floor(startBit / 8);
  const endByte = Math.floor((startBit + bitLength - 1) / 8);

  for (let i = startByte; i <= endByte; i++) {
    indices.add(i);
  }

  return indices;
}
