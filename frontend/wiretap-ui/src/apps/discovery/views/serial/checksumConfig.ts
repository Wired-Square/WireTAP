// ui/src/apps/discovery/views/serial/checksumConfig.ts
//
// One owner for converting between the three shapes a serial checksum takes:
// the detector's `ChecksumCandidate`, the UI's `ChecksumConfig`, and the
// catalogue's `FrameChecksum`.
//
// These conversions used to be written by hand at six sites, and `endianness`
// was silently dropped at three of them — a little-endian CRC-16 chosen in the
// dialog came back big-endian and read 0%. Anything that crosses between the
// shapes goes through here so the next field cannot go missing the same way.

import type { ChecksumCandidate } from '../../../../api/checksums';
import type { FrameChecksum } from '../../../../types/catalogModel';
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
export function serialChecksumFromConfig(config: ChecksumConfig): FrameChecksum | null {
  if (config.algorithm === 'unknown') return null;
  return {
    algorithm: config.algorithm,
    startByte: config.startByte,
    byteLength: config.numBytes,
    calcStartByte: config.calcStartByte,
    calcEndByte: config.calcEndByte,
    endianness: config.numBytes > 1 ? config.endianness : undefined,
  };
}

/**
 * Back from the catalogue/export shape.
 *
 * No byte order is little-endian, as the catalogue reads a legacy file. The
 * reverse mapper used to default the other way, which is how a stored
 * little-endian config came back big.
 */
export function configFromSerialChecksum(checksum: FrameChecksum): ChecksumConfig {
  return {
    algorithm: checksum.algorithm as DiscoveryChecksumAlgorithm,
    numBytes: checksum.byteLength,
    startByte: checksum.startByte,
    endianness: checksum.endianness ?? 'little',
    calcStartByte: checksum.calcStartByte,
    calcEndByte: checksum.calcEndByte ?? -1,
  };
}
