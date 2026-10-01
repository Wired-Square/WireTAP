// Generated from the Rust serde types by `npm run gen:types`. Do not edit.
import type { ModbusScanConfig } from "./ModbusScanConfig";
import type { UnitIdScanConfig } from "./UnitIdScanConfig";

/**
 * Which sweep this session runs.
 *
 * The function-code probe is deliberately absent: it makes at most four
 * requests, produces no frames and needs no capture, so it runs as a plain
 * call rather than dragging a session along behind it.
 */
export type ScanJob = { "kind": "registers", config: ModbusScanConfig, } | { "kind": "unit_ids", config: UnitIdScanConfig, };
