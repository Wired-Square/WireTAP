// Generated from the Rust serde types by `npm run gen:types`. Do not edit.
import type { TimestampedByte } from "./TimestampedByte";

/**
 * Response for tail-mode byte capture queries
 */
export type BytesTailResponse = { bytes: Array<TimestampedByte>, total_count: number, };
