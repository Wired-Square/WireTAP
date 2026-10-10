// Generated from the Rust serde types by `npm run gen:types`. Do not edit.
import type { QueryResults } from "./QueryResults";
import type { QueryStats } from "./QueryStats";

/**
 * A query's answer and the statements that produced it: SQLite with its values
 * in place for a capture, the HTTP request for a backend.
 */
export type QueryOutcome = { results: QueryResults, stats: QueryStats | null, sql: Array<string>, 
/**
 * An inventory stopped at its limit: more frame ids may exist.
 */
truncated: boolean, };
