// ui/src/apps/discovery/views/serial/checksumConfig.ts
//
// One owner for converting between the three shapes a serial checksum takes:
// the detector's `ChecksumCandidate`, the UI's `ChecksumConfig`, and the
// catalogue's `SerialChecksumConfig`.
//
// These conversions used to be written by hand at six sites, and `endianness`
// was silently dropped at three of them — a little-endian CRC-16 chosen in the
// dialog came back big-endian and read 0%. Anything that crosses between the
// shapes goes through here so the next field cannot go missing the same way.

import type { ChecksumCandidate } from '../../../../api/checksums';
import type { SerialChecksumConfig } from '../../../../utils/frameExport';
import type { ChecksumConfig, DiscoveryChecksumAlgorithm } from './serialTypes';

/** A detected candidate, as the dialog's editable configuration. */
export function configFromCandidate(candidate: ChecksumCandidate): ChecksumConfig {
  return {
    algorithm: candidate.algorithm,
    numBytes: candidate.length,
    startByte: candidate.position,
    endianness: candidate.bigEndian ? 'big' : 'little',
    calcStartByte: candidate.calcStartByte,
    calcEndByte: candidate.calcEndByte,
  };
}

/** True when a configuration is exactly this candidate's geometry. */
export function matchesCandidate(config: ChecksumConfig, candidate: ChecksumCandidate): boolean {
  return (
    config.algorithm === candidate.algorithm &&
    config.numBytes === candidate.length &&
    config.startByte === candidate.position &&
    (config.endianness === 'big') === candidate.bigEndian &&
    config.calcStartByte === candidate.calcStartByte &&
    config.calcEndByte === candidate.calcEndByte
  );
}

/**
 * The catalogue/export shape.
 *
 * Returns `null` for `'unknown'` — a UI-only placeholder that must never reach a
 * catalogue, since nothing can decode it.
 */
export function serialChecksumFromConfig(config: ChecksumConfig): SerialChecksumConfig | null {
  if (config.algorithm === 'unknown') return null;
  return {
    algorithm: config.algorithm,
    start_byte: config.startByte,
    byte_length: config.numBytes,
    calc_start_byte: config.calcStartByte,
    calc_end_byte: config.calcEndByte,
    big_endian: config.endianness === 'big',
  };
}

/**
 * Back from the catalogue/export shape.
 *
 * `big_endian` absent means little-endian, matching `frameExport`'s own doc and
 * the catalogue parser's `unwrap_or(false)`. The reverse mapper used to default
 * the other way, which is how a stored little-endian config came back big.
 */
export function configFromSerialChecksum(checksum: SerialChecksumConfig): ChecksumConfig {
  return {
    algorithm: checksum.algorithm as DiscoveryChecksumAlgorithm,
    numBytes: checksum.byte_length,
    startByte: checksum.start_byte,
    endianness: checksum.big_endian === true ? 'big' : 'little',
    calcStartByte: checksum.calc_start_byte,
    calcEndByte: checksum.calc_end_byte,
  };
}
