// Generated from the Rust serde types by `npm run gen:types`. Do not edit.
import type { ShareErrorKind } from "./ShareErrorKind";

/**
 * A typed failure. `kind` drives UI behaviour — whether to offer Retry, deep-link
 * to the account settings, or just show the message.
 */
export type ShareError = { kind: ShareErrorKind, message: string, 
/**
 * Seconds until a rate limit resets, when known.
 */
retryAfterSecs?: number, };
