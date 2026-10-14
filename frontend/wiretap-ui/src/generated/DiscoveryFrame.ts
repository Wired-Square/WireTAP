// Generated from the Rust serde types by `npm run gen:types`. Do not edit.

/**
 * Just enough of a `FrameMessage` to group and analyse. Serde ignores the rest
 * of the fields the frontend sends.
 */
export type DiscoveryFrame = { frame_id: number, bytes: Array<number>, is_extended?: boolean, };
