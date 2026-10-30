// Generated from the Rust serde types by `npm run gen:types`. Do not edit.
import type { AdditiveOp } from "./AdditiveOp";
import type { ChecksumAlgorithm } from "./ChecksumAlgorithm";
import type { CrcParameters } from "./CrcParameters";

/**
 * How a checksum is computed: a named algorithm from the sweep, or a family
 * [`solve_additive`] or [`solve_crc`] recovered with its parameters.
 */
export type ChecksumSpecification = { "kind": "named", algorithm: ChecksumAlgorithm, } | { "kind": "additive", op: AdditiveOp, offset: number, } | { "kind": "crc" } & CrcParameters;
