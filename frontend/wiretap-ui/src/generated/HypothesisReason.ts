// Generated from the Rust serde types by `npm run gen:types`. Do not edit.
import type { PatternKind } from "./PatternKind";
import type { RoleKind } from "./RoleKind";

/**
 * Why a candidate scored as it did; the caller renders these as text.
 */
export type HypothesisReason = { "code": "role", role: RoleKind, } | { "code": "pattern", kind: PatternKind, exact: boolean, } | { "code": "endiannessAgrees" } | { "code": "endiannessMixed" } | { "code": "highVariance" } | { "code": "strongTrend" } | { "code": "noProfile" };
