// Generated from the Rust serde types by `npm run gen:types`. Do not edit.
import type { ValidationCode } from "./ValidationCode";

/**
 * A rejection: what was wrong, and which input to focus.
 */
export type ProfileValidationError = { code: ValidationCode, field: string | null, };
