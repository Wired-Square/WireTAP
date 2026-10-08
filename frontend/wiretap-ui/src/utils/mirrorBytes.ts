// ui/src/utils/mirrorBytes.ts
//
// The bytes a mirror frame reproduces are Rust's answer
// (`wiretap_catalog::mirror::inherited_byte_indices`); this only spans a signal
// for highlighting.

/** The bits of a signal a byte span needs. */
type ByteSpanSignal = {
  start_bit?: number;
  bit_length?: number;
};

/** Byte indices a signal covers, from its `start_bit` / `bit_length`. */
export function signalByteIndices(signal: ByteSpanSignal): Set<number> {
  const indices = new Set<number>();
  const startBit = signal.start_bit ?? 0;
  const bitLength = signal.bit_length ?? 8;

  const startByte = Math.floor(startBit / 8);
  const endByte = Math.floor((startBit + bitLength - 1) / 8);

  for (let i = startByte; i <= endByte; i++) {
    indices.add(i);
  }

  return indices;
}
