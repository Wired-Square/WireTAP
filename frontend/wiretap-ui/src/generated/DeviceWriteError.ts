// Generated from the Rust serde types by `npm run gen:types`. Do not edit.
import type { ProfileValidationError } from "./ProfileValidationError";

/**
 * Why a device write was refused: a rule the form can point at, or a failure
 * it can only report.
 */
export type DeviceWriteError = ProfileValidationError | string;
