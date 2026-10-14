// Generated from the Rust serde types by `npm run gen:types`. Do not edit.
import type { AdditiveOp } from "./AdditiveOp";
import type { ChecksumAlgorithm } from "./ChecksumAlgorithm";
import type { CrcParameters } from "./CrcParameters";

/**
 * How a checksum is computed.
 *
 * One type for all three answers the engine can give: a named algorithm from
 * the scored sweep, or one of the two families [`solve_additive`] and
 * [`solve_crc`] recover, which carry parameters no fixed list can express.
 * They were declared separately either side of the crate boundary and sorted
 * against each other in one list.
 */
export type ChecksumSpecification = { "kind": "named", algorithm: ChecksumAlgorithm, } | { "kind": "additive", op: AdditiveOp, offset: number, } | { "kind": "crc" } & CrcParameters;
