// Generated from the Rust serde types by `npm run gen:types`. Do not edit.

/**
 * What a session was opened from. A stopped source replaying its capture is
 * still a device session; one opened on a capture is a capture session.
 */
export type SessionSourceKind = "device" | "capture";
