// Generated from the Rust serde types by `npm run gen:types`. Do not edit.
import type { ShareErrorKind } from "./ShareErrorKind";

export type UpdateCheckFailure = { repoLabel: string, kind: ShareErrorKind, message: string, 
/**
 * Seconds until a rate limit resets, when known.
 */
retryAfterSecs?: number, };
