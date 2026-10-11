// Generated from the Rust serde types by `npm run gen:types`. Do not edit.
import type { IoErrorKind } from "./IoErrorKind";

/**
 * A failure as it reaches the frontend: its kind, in the words it is shown in.
 */
export type IoFailure = { kind: IoErrorKind, message: string, };
