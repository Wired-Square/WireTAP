// Generated from the Rust serde types by `npm run gen:types`. Do not edit.
import type { CsvColumnMapping } from "./CsvColumnMapping";
import type { Delimiter } from "./Delimiter";
import type { Protocol } from "./Protocol";
import type { TimestampUnit } from "./TimestampUnit";

/**
 * Result of previewing a CSV file
 */
export type CsvPreview = { 
/**
 * Raw header strings (if first row is a header)
 */
headers: Array<string> | null, 
/**
 * First N rows of raw string values
 */
rows: Array<Array<string>>, 
/**
 * Total number of data rows in the file (excluding header)
 */
total_rows: number, 
/**
 * Auto-detected column mappings (user can override)
 */
suggested_mappings: Array<CsvColumnMapping>, 
/**
 * Whether the first row appears to be a header
 */
has_header: boolean, 
/**
 * Auto-detected timestamp unit based on sample data heuristics
 */
suggested_timestamp_unit: TimestampUnit, 
/**
 * Whether the sample timestamps are all negative (suggests negate fix)
 */
has_negative_timestamps: boolean, 
/**
 * Detected or user-specified delimiter
 */
delimiter: Delimiter, suggested_protocol: Protocol, };
