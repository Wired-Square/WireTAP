// Generated from the Rust serde types by `npm run gen:types`. Do not edit.
import type { ChecksumEvidence } from "./ChecksumEvidence";
import type { ChecksumNote } from "./ChecksumNote";
import type { DiscoveredChecksum } from "./DiscoveredChecksum";

/**
 * What the scan found for one frame id — including when it found nothing, so
 * the reason is visible rather than the id simply vanishing from the results.
 */
export type FrameChecksumFinding = { 
/**
 * Frames seen for this id.
 */
frameCount: number, 
/**
 * Distinct payloads among them. A checksum cannot be recovered from
 * repeats, so this is the number that actually bounds the search.
 */
distinctPayloads: number, candidates: Array<DiscoveredChecksum>, 
/**
 * What identification decided about each byte column, rejections included.
 * This is the useful half of an empty result: not "nothing found" but
 * "byte -1 never changes, byte -2 is a counter".
 */
columns: Array<ChecksumEvidence>, notes: Array<ChecksumNote>, frameId: number, isExtended: boolean, };
