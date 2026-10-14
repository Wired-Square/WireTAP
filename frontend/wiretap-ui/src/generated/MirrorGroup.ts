// Generated from the Rust serde types by `npm run gen:types`. Do not edit.
import type { FrameKey } from "./FrameKey";

/**
 * Ids whose payloads mirror each other, directly or through another member.
 */
export type MirrorGroup = { 
/**
 * Ascending.
 */
keys: Array<FrameKey>, 
/**
 * Sparser-side samples with a partner in the window, over the group's mirrored
 * pairs.
 */
sampleCount: number, 
/**
 * The share of those with an equal payload in the window, rounded, 80–100.
 */
matchPercentage: number, samplePayload: Array<number>, };
