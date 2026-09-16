// ui/src/utils/mirrorBytes.ts
//
// Which payload bytes a mirror frame is expected to reproduce verbatim.
//
// The `_inherited` flag these read is set in Rust by
// `wiretap_catalog::parse::resolve_mirror_inheritance` — a signal the mirror
// declares at the same `start_bit:bit_length` as its source *overrides* the
// inherited one and is not flagged. So an overridden byte is deliberately
// different data (`0x504`'s sign-inverted current, `0x005`'s end-stop flag) and
// must not be reported as a mismatch.
//
// The live Decoder gets its verdict from Rust
// (`wiretap_catalog::mirror::MirrorTracker`). This module exists for the two
// places TypeScript still has to answer the same question itself: rendering the
// per-signal ✓/×, and telling the offline mirror-validation queries which bytes
// to compare so they agree with the live badge.

/**
 * The bits of a signal these functions need — structural, so both the decoder's
 * `SignalDef` and the catalogue parser's `ResolvedSignal` satisfy it.
 */
export type ByteSpanSignal = {
  start_bit?: number;
  bit_length?: number;
  _inherited?: boolean;
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

/**
 * Byte indices covered by a frame's inherited signals, ascending.
 *
 * Empty for a frame that is not a mirror, which callers should read as "no
 * restriction" rather than "compare nothing".
 */
export function inheritedByteIndices(signals: ByteSpanSignal[]): number[] {
  const indices = new Set<number>();
  for (const signal of signals) {
    // Must match `inherited_byte_indices` exactly, including skipping a signal
    // with no explicit span — `signalByteIndices`' 8-bit default is for the
    // rendering callers, and applying it here would compare a byte Rust does not.
    if (!signal._inherited || signal.start_bit === undefined || !signal.bit_length) continue;
    for (const index of signalByteIndices(signal)) indices.add(index);
  }
  return [...indices].sort((a, b) => a - b);
}
