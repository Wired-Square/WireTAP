// Generated from the Rust serde types by `npm run gen:types`. Do not edit.

export type QueryStats = { rows_scanned: number, results_count: number, execution_time_ms: number, 
/**
 * The bus the gateway filtered on; absent when it filtered none, or predates bus filters.
 */
bus?: number, };
