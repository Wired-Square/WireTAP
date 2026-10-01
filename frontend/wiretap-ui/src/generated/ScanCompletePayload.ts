// Generated from the Rust serde types by `npm run gen:types`. Do not edit.
import type { DeviceInfoPayload } from "./DeviceInfoPayload";
import type { RegisterBlock } from "./RegisterBlock";

/**
 * Completion summary returned when scan finishes
 */
export type ScanCompletePayload = { 
/**
 * Total responding items found
 */
found_count: number, 
/**
 * Total items scanned
 */
total_scanned: number, 
/**
 * Scan duration in milliseconds
 */
duration_ms: number, 
/**
 * Requests actually issued — the honest cost of the sweep.
 */
requests: number, 
/**
 * Contiguous runs of responding addresses. A wide sweep of a real device
 * collapses to a handful of these, which is what makes the result
 * summarisable instead of one row per register.
 */
blocks: Array<RegisterBlock>, 
/**
 * Contiguous runs that did not respond.
 */
gaps: Array<RegisterBlock>, 
/**
 * Diagnoses, e.g. "input: no response after 3 consecutive timeouts".
 */
notes: Array<string>, 
/**
 * True when the scan stopped early (cancelled or out of request budget).
 */
truncated: boolean, 
/**
 * Unit-ID scans only: what each responding slave said about itself.
 * Naturally small — at most one entry per unit id.
 */
devices: Array<DeviceInfoPayload>, };
