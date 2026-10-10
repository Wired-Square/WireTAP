// Generated from the Rust serde types by `npm run gen:types`. Do not edit.

/**
 * Where a query runs: a SQLite capture or a WireTAP backend profile.
 */
export type QuerySource = { "kind": "capture", "id": string } | { "kind": "backend", "id": string };
