// Generated from the Rust serde types by `npm run gen:types`. Do not edit.

/**
 * Which [`IoError`] a failure is: one per variant, so the frontend branches on
 * this rather than on the message. The discriminant is its byte on the wire.
 */
export type IoErrorKind = "connection" | "dnsResolution" | "timeout" | "protocol" | "transmission" | "configuration" | "deviceNotFound" | "deviceBusy" | "deviceDisconnected" | "read" | "sessionNotFound" | "other";
