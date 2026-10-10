// Generated from the Rust serde types by `npm run gen:types`. Do not edit.
import type { QuerySource } from "./QuerySource";
import type { QuerySpec } from "./QuerySpec";
import type { QueryStats } from "./QueryStats";
import type { QueryStatus } from "./QueryStatus";

export type QueryItem = { id: string, label: string, status: QueryStatus, submitted_at_ms: number, started_at_ms: number | null, completed_at_ms: number | null, error: string | null, result_count: number | null, stats: QueryStats | null, source: QuerySource, spec: QuerySpec, catalog_path?: string, };
