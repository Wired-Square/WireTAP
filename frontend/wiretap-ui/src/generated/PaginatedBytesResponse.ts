// Generated from the Rust serde types by `npm run gen:types`. Do not edit.
import type { TimestampedByte } from "./TimestampedByte";

/**
 * Response for paginated capture bytes
 */
export type PaginatedBytesResponse = { bytes: Array<TimestampedByte>, total_count: number, offset: number, limit: number, };
