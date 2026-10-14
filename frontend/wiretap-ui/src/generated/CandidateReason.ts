// Generated from the Rust serde types by `npm run gen:types`. Do not edit.

/**
 * Why a candidate scored as it did; the caller renders these as text.
 */
export type CandidateReason = { "code": "protocolMarkers" } | { "code": "commandIds" } | { "code": "typeSubtype", firstByteValues: number, } | { "code": "deviceCount", count: number, } | { "code": "addressCount", count: number, } | { "code": "twelveBitRange" } | { "code": "evenDistribution" } | { "code": "smallAddresses" } | { "code": "noZeroAddress" };
