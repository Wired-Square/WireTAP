// ui/src/api/checksums.ts
//
// Tauri API wrappers for checksum calculation functions.
// These call the Rust backend for checksum calculations.

import { invoke } from "@tauri-apps/api/core";
import type { ProtocolFrames } from "../utils/frameKey";

// ============================================================================
// Types
// ============================================================================

/**
 * Supported checksum algorithms.
 * Must match the Rust ChecksumAlgorithm enum.
 */
export type ChecksumAlgorithm =
  | "xor"
  | "sum8"
  | "crc8"
  | "crc8_sae_j1850"
  | "crc8_autosar"
  | "crc8_maxim"
  | "crc8_cdma2000"
  | "crc8_dvb_s2"
  | "crc8_nissan"
  | "crc16_modbus"
  | "crc16_ccitt";

/**
 * Result of checksum validation.
 */
export interface ChecksumValidationResult {
  /** The checksum value extracted from the frame */
  extracted: number;
  /** The calculated checksum value */
  calculated: number;
  /** Whether the checksum is valid (extracted === calculated) */
  valid: boolean;
}

// ============================================================================
// API Functions
// ============================================================================

/**
 * Calculate checksum using the specified algorithm with byte range.
 *
 * @param algorithm - The checksum algorithm to use
 * @param data - The complete frame data as bytes
 * @param calcStartByte - First byte index to include (supports negative indexing)
 * @param calcEndByte - Last byte index exclusive (supports negative indexing)
 * @returns The calculated checksum value
 */
export async function calculateChecksum(
  algorithm: ChecksumAlgorithm,
  data: number[] | Uint8Array,
  calcStartByte: number,
  calcEndByte: number
): Promise<number> {
  const dataArray = data instanceof Uint8Array ? Array.from(data) : data;
  return invoke<number>("calculate_checksum_cmd", {
    algorithm,
    data: dataArray,
    calcStartByte,
    calcEndByte,
  });
}

/**
 * Validate a checksum in frame data.
 *
 * @param algorithm - The checksum algorithm to use
 * @param data - The complete frame data as bytes
 * @param startByte - Byte offset where checksum is stored (supports negative indexing)
 * @param byteLength - Length of checksum (1 or 2 bytes)
 * @param bigEndian - true for big-endian, false for little-endian
 * @param calcStartByte - First byte to include in calculation (supports negative indexing)
 * @param calcEndByte - Last byte (exclusive) to include (supports negative indexing)
 * @returns Validation result with extracted, calculated, and valid fields
 */
export async function validateChecksum(
  algorithm: ChecksumAlgorithm,
  data: number[] | Uint8Array,
  startByte: number,
  byteLength: number,
  bigEndian: boolean,
  calcStartByte: number,
  calcEndByte: number
): Promise<ChecksumValidationResult> {
  const dataArray = data instanceof Uint8Array ? Array.from(data) : data;
  return invoke<ChecksumValidationResult>("validate_checksum_cmd", {
    algorithm,
    data: dataArray,
    startByte,
    byteLength,
    bigEndian,
    calcStartByte,
    calcEndByte,
  });
}

/**
 * Resolve a byte index, supporting negative indexing.
 * Negative indices count from the end: -1 = last byte, -2 = second-to-last, etc.
 *
 * @param index - The byte index (can be negative)
 * @param frameLength - Total frame length in bytes
 * @returns The resolved absolute byte index
 */
export async function resolveByteIndex(
  index: number,
  frameLength: number
): Promise<number> {
  return invoke<number>("resolve_byte_index_cmd", {
    index,
    frameLength,
  });
}

/** One point in the checksum candidate space. */
export interface ChecksumSpec {
  algorithm: ChecksumAlgorithm;
  /** Byte offset of the checksum; negative counts from the end. */
  position: number;
  byteLength: 1 | 2;
  bigEndian: boolean;
  calcStartByte: number;
  calcEndByte: number;
}

export interface ChecksumSpecResult {
  /** Index into the `specs` array passed in. */
  specIndex: number;
  matchCount: number;
  /** Frames the spec fitted — frames too short for it are excluded, not counted as misses. */
  totalCount: number;
}

export interface ChecksumSweepResponse {
  results: ChecksumSpecResult[];
}

/**
 * A translatable note. Rust decides *what* to say, the frontend decides how —
 * render with `t(\`serial.checksumNote.${code}\`, values)`.
 */
export interface ChecksumNote {
  code: string;
  values: Record<string, string | number>;
}

/**
 * What one end-relative byte column looks like across the sample: the structural
 * evidence behind the detector's priors.
 *
 * The same statistics the identification pass judges a column on, because both
 * halves now profile the columns once and share the result — a byte cannot be
 * called padding by one and swept as a candidate by the other.
 */
export interface ColumnStats {
  /** Negative index, e.g. -1 for the last byte. */
  position: number;
  distinctValues: number;
  min: number;
  max: number;
  /** Set when the column holds one value across every sampled frame. */
  constantValue: number | null;
  /** Consecutive frame pairs in which this byte differed. */
  changes: number;
  /** Consecutive frame pairs the column took part in. */
  transitions: number;
  /** Shannon entropy of the observed values, in bits; 8.0 is a byte's most. */
  entropyBits: number;
  sampleCount: number;
}

export interface ChecksumCandidate {
  algorithm: ChecksumAlgorithm;
  position: number;
  length: 1 | 2;
  bigEndian: boolean;
  calcStartByte: number;
  calcEndByte: number;
  matchCount: number;
  totalCount: number;
  /** 0-100 */
  matchRate: number;
  /** 0-100 composite score. */
  confidence: number;
  notes: ChecksumNote[];
  /** Other calculation ranges that scored identically. */
  equivalentRanges: { calcStartByte: number; calcEndByte: number }[];
}

export interface ChecksumDetectionResult {
  candidates: ChecksumCandidate[];
  bestCandidate: ChecksumCandidate | null;
  tailColumns: ColumnStats[];
  /** Result-level explanation, including why nothing was found. */
  notes: ChecksumNote[];
}

export interface ChecksumDetectionOptions {
  /** Checksum offsets to try, end-relative (default [-1, -2, -3]). */
  positions?: number[];
  /** Restrict to checksums of these byte lengths; omit for both. */
  lengths?: (1 | 2)[];
  /**
   * Byte offsets just past a declared header field, from the view's ID/Source
   * chips. These widen the calculation-range candidates; they never narrow them.
   */
  headerBoundaries?: number[];
  /** Percentage below which a candidate is discarded (default 50). */
  minMatchRate?: number;
  /** Confidence below which a candidate is discarded (default 35). */
  minConfidence?: number;
}

/**
 * Rank the checksum configurations that explain a set of frames.
 *
 * The whole engine — candidate space, structural priors, confidence scoring —
 * lives in Rust beside the algorithms, so there is one implementation of each.
 * One IPC call for the whole search.
 */
export async function detectChecksum(
  frames: number[][],
  options: ChecksumDetectionOptions = {}
): Promise<ChecksumDetectionResult> {
  return invoke<ChecksumDetectionResult>("detect_checksum_cmd", { frames, options });
}

/**
 * Check specific checksum configurations against frames.
 *
 * For the live match rate behind a hand-edited configuration, where the caller
 * has one spec rather than a space to search. Unlike `batchTestCrc` above, the
 * response needs no field mapping — the Rust structs are `rename_all = "camelCase"`.
 */
export async function sweepChecksumSpecs(
  frames: number[][],
  specs: ChecksumSpec[]
): Promise<ChecksumSweepResponse> {
  if (specs.length === 0) return { results: [] };
  return invoke<ChecksumSweepResponse>("sweep_checksum_specs_cmd", { frames, specs });
}

// ============================================================================
// Discovery across a capture
// ============================================================================

/** The additive families the solver recognises. */
export type AdditiveOp = "xor" | "sum" | "negatedSum";

/** One conventional `init` and the `xorOut` it implies for a recovered residue. */
export interface CrcAlternative {
  init: number;
  xorOut: number;
}

/**
 * A recovered CRC.
 *
 * `init`/`xorOut` are the canonical pair — always exact, and for fixed-length
 * payloads never the *only* pair that fits, which is what `alternatives` is
 * for. Present one of them as the answer and you are guessing.
 */
export interface CrcParameters {
  /** 8 or 16. */
  width: number;
  polynomial: number;
  reflectIn: boolean;
  reflectOut: boolean;
  init: number;
  xorOut: number;
  /** True when the polynomial is a recognised standard. */
  wellKnown: boolean;
  alternatives: CrcAlternative[];
}

/**
 * How a checksum is computed. `named` came from the scored sweep of the eleven
 * built-in algorithms; the other two were solved, and carry parameters no fixed
 * list can express.
 */
export type ChecksumSpecification =
  | { kind: "named"; algorithm: ChecksumAlgorithm }
  | { kind: "additive"; op: AdditiveOp; offset: number }
  | ({ kind: "crc" } & CrcParameters);

/** One configuration that explains a frame id, with the evidence for it. */
export interface DiscoveredChecksum {
  specification: ChecksumSpecification;
  position: number;
  length: number;
  bigEndian: boolean;
  calcStartByte: number;
  calcEndByte: number;
  /** Samples the configuration reproduced. */
  matchCount: number;
  /** Samples it was measured against. */
  totalCount: number;
  /**
   * 0-100, and `null` for a solved configuration.
   *
   * A solve reproduces every sample it was verified against or is not reported
   * at all, so there is no rate to state — render the sample count instead.
   */
  matchRate: number | null;
  /** Samples left out because their calculation range was a different length. */
  excludedCount: number;
  /** 0-100 composite score. */
  confidence: number;
  notes: ChecksumNote[];
  equivalentRanges: { calcStartByte: number; calcEndByte: number }[];
}

/** Why identification ruled a byte column out before the solver was asked. */
export type ChecksumRejection =
  | "constant"
  | "notAFunctionOfTheOtherBytes"
  | "tooOftenUnchanged"
  | "tooFewTransitions"
  | "tooFewDistinctValues";

/**
 * What identification decided about one byte column.
 *
 * A checksum is a function of the other bytes, so a column that changes while
 * every other byte holds still cannot be one — that rejection is arithmetic,
 * not a threshold. What survives is judged on how reliably it moves with the
 * payload, and on taking roughly as many values as there are distinct payloads.
 */
export interface ChecksumEvidence {
  /** End-relative index: -1 is the last byte. */
  position: number;
  payloadChanged: number;
  changedWithPayload: number;
  changedAlone: number;
  /** `changedWithPayload / payloadChanged`. */
  responsiveness: number;
  entropyBits: number;
  distinctRatio: number;
  /** 0-100. Zero when `rejected` is set. */
  likeness: number;
  rejected: ChecksumRejection | null;
}

/**
 * What the scan found for one frame id — including when it found nothing, so
 * the reason stays visible instead of the id vanishing from the results.
 */
export interface FrameChecksumFinding {
  frameId: number;
  isExtended: boolean;
  frameCount: number;
  /**
   * Distinct payloads among them. A checksum cannot be recovered from repeats,
   * so this — not `frameCount` — is what bounds the search.
   */
  distinctPayloads: number;
  candidates: DiscoveredChecksum[];
  /**
   * What identification decided about each byte column. This is the useful half
   * of an empty result: not "nothing found" but "byte -1 never changes, byte -2
   * is a counter".
   */
  columns: ChecksumEvidence[];
  notes: ChecksumNote[];
}

export interface ChecksumDiscoveryResult {
  findings: FrameChecksumFinding[];
  frameCount: number;
  uniqueFrameIds: number;
  /** Ids skipped for having fewer than `minSamples` frames. */
  skippedFrameIds: number;
}

export interface ChecksumDiscoveryOptions {
  /** Frames an id needs before it is worth analysing (default 10). */
  minSamples?: number;
  /** Checksum offsets to try, end-relative (default [-1, -2, -3]). */
  positions?: number[];
  /** Recover arbitrary CRC polynomials, not only the named algorithms. */
  searchCustomPolynomials?: boolean;
  /**
   * How checksum-shaped a byte column must look before the solver is asked
   * about it (default 50). Zero solves every column not rejected outright.
   *
   * The only sensitivity control there is. Match rate, confidence floor and the
   * per-id candidate cap are fixed in Rust — they were reachable from no
   * surface, and none of them is a judgement a user is placed to make.
   */
  minLikeness?: number;
}

/**
 * Scan a capture for checksums: group by frame id, then work out what explains
 * each group.
 *
 * **The request is a capture id and a selection, not the frames** — Rust already
 * has the payloads. An empty selection scans every frame the capture holds. Runs
 * the same scan the `frame_checksum_scan` MCP tool does, so an agent and the
 * panel cannot reach different answers about one capture.
 */
export async function discoverChecksumsInCapture(
  captureId: string,
  selection: ProtocolFrames[],
  options: ChecksumDiscoveryOptions = {}
): Promise<ChecksumDiscoveryResult> {
  return invoke<ChecksumDiscoveryResult>("discover_checksums_in_capture_cmd", {
    capture_id: captureId,
    selection,
    options,
  });
}

/** Frames as the scan wants them — a `FrameMessage` already satisfies this. */
export interface DiscoveryFrame {
  frame_id: number;
  bytes: number[];
  is_extended?: boolean;
}

/**
 * Scan frames the frontend holds and no capture does — client-side serial
 * framing, and a session running without one. Everything capture-backed goes
 * through `discoverChecksumsInCapture`; both land in the same Rust engine.
 */
export async function discoverChecksums(
  frames: DiscoveryFrame[],
  options: ChecksumDiscoveryOptions = {}
): Promise<ChecksumDiscoveryResult> {
  return invoke<ChecksumDiscoveryResult>("discover_checksums_cmd", { frames, options });
}
