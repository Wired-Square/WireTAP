// Generated from the Rust serde types by `npm run gen:types`. Do not edit.
import type { QuerySource } from "./QuerySource";
import type { QuerySpec } from "./QuerySpec";

/**
 * A query and where it runs. `catalog_path` narrows a mirror validation to the
 * mirror's inherited bytes.
 */
export type QueryRequest = { source: QuerySource, spec: QuerySpec, catalog_path?: string, };
