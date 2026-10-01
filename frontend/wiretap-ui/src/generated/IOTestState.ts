// Generated from the Rust serde types by `npm run gen:types`. Do not edit.
import type { AutoPhaseResult } from "./AutoPhaseResult";
import type { LatencyStats } from "./LatencyStats";
import type { PeerInfo } from "./PeerInfo";
import type { RemoteStats } from "./RemoteStats";
import type { SweepRow } from "./SweepRow";
import type { TestMode } from "./TestMode";
import type { TestRole } from "./TestRole";
import type { TestStatus } from "./TestStatus";

export type IOTestState = { test_id: string, status: TestStatus, mode: TestMode, role: TestRole, tx_count: number, rx_count: number, drops: number, duplicates: number, out_of_order: number, 
/**
 * The first [`MAX_KEPT_GAPS`] gaps, not necessarily all of them — `drops`
 * is the authoritative count.
 */
sequence_gaps: Array<[number, number]>, latency_us: LatencyStats | null, elapsed_sec: number, frames_per_sec: number, errors: Array<string>, remote: RemoteStats | null, 
/**
 * What the `Hello` handshake found, once it has answered.
 */
peer: PeerInfo | null, 
/**
 * Per-length-code results, for a Sweep run.
 */
sweep: Array<SweepRow> | null, 
/**
 * Phase results for Auto mode.
 */
auto_results: Array<AutoPhaseResult> | null, 
/**
 * Current phase label for Auto mode (e.g. "Echo (1/5)").
 */
auto_phase: string | null, };
