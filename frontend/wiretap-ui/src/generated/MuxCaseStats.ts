// Generated from the Rust serde types by `npm run gen:types`. Do not edit.
import type { BytePositionStats } from "./BytePositionStats";
import type { Word16Stats } from "./Word16Stats";

export type MuxCaseStats = { mux_value: number, frame_count: number, byte_stats: Array<BytePositionStats>, word16_stats: Array<Word16Stats>, };
