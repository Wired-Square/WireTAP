// Generated from the Rust serde types by `npm run gen:types`. Do not edit.
import type { LatencyStats } from "./LatencyStats";
import type { RemoteStats } from "./RemoteStats";
import type { SweepRow } from "./SweepRow";

/**
 * Result of a single phase in an Auto test.
 */
export type AutoPhaseResult = { phase: string, passed: boolean, tx_count: number, rx_count: number, drops: number, frames_per_sec: number, elapsed_sec: number, latency_us: LatencyStats | null, remote: RemoteStats | null, sweep: Array<SweepRow> | null, errors: Array<string>, };
